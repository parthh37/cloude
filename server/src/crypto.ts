import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

// ---- Passwords (scrypt, no native deps) -------------------------------------

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** OWASP's 32 MiB scrypt profile. Runs on the libuv pool, so logins don't stall the event loop. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 3 };

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  // v1 format "scrypt$salt$hash" used fixed N=16384,r=8,p=1.
  if (parts[0] === 'scrypt' && parts.length === 3) {
    return { N: 16384, r: 8, p: 1, salt: Buffer.from(parts[1]!, 'hex'), hash: Buffer.from(parts[2]!, 'hex') };
  }
  if (parts[0] === 'scrypt' && parts.length === 6) {
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (!N || !r || !p) return null;
    return { N, r, p, salt: Buffer.from(parts[4]!, 'hex'), hash: Buffer.from(parts[5]!, 'hex') };
  }
  return null;
}

const derive = (password: string, h: Pick<ParsedHash, 'N' | 'r' | 'p' | 'salt'>, len: number) =>
  scrypt(password, h.salt, len, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r });

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password.normalize('NFKC'), { ...SCRYPT, salt }, 64);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h || h.hash.length === 0) return false;
  // v1 hashes were made without NFKC normalisation; keep verifying them byte-for-byte.
  const input = stored.split('$').length === 3 ? password : password.normalize('NFKC');
  return crypto.timingSafeEqual(h.hash, await derive(input, h, h.hash.length));
}

/** True when a stored hash uses weaker parameters than today's, so it should be upgraded on next login. */
export function needsRehash(stored: string): boolean {
  const h = parseHash(stored);
  return !h || h.N < SCRYPT.N || h.r < SCRYPT.r || h.p < SCRYPT.p || stored.split('$').length !== 6;
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Constant-time string comparison (lengths may differ). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
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
