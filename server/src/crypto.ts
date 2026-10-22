import crypto from 'node:crypto';
import { config } from './config.js';

// ---- Passwords (scrypt, no native deps) -------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// ---- Signed, expiring tokens (used for preview-auth handoff) ----------------

export function signToken(payload: Record<string, unknown>, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data as T;
  } catch {
    return null;
  }
}

// ---- Secret values at rest (AES-256-GCM) -----------------------------------

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.secret, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.secret, Buffer.from(iv!, 'base64'));
  decipher.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data!, 'base64')), decipher.final()]).toString('utf8');
}

export const newId = () => crypto.randomUUID();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
