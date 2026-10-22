import crypto from 'node:crypto';
import { config } from '../config.js';
import { safeEqual } from '../crypto.js';

// RFC 6238 time-based one-time passwords (what Google Authenticator, 1Password,
// Authy etc. implement): HMAC-SHA1, 6 digits, 30-second steps.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

export const currentStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

/**
 * Check a code against the current step ±1 (clock drift). Returns the matched
 * step so the caller can persist it: a step at or before `lastStep` is refused,
 * which stops a code that was shoulder-surfed or phished from being replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep: number, at = Date.now()): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const step = currentStep(at);
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing doesn't reveal which step matched.
  for (const s of [step - 1, step, step + 1]) {
    if (safeEqual(hotp(secret, s), digits) && s > lastStep) matched = s;
  }
  return matched;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const qs = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${qs}`;
}

// ---- recovery codes ------------------------------------------------------------

/** "k7f2q-9xm4d": 50 bits each, easy to read aloud, no 0/O or 1/I confusion. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/**
 * Recovery codes carry 50 bits — fine against online guessing (throttled), not
 * against a GPU with a leaked database. Keying the hash with Cloude's secret
 * (kept in secret.key, outside the DB) means the DB alone isn't enough.
 */
export const hashRecoveryCode = (code: string) =>
  crypto.createHmac('sha256', config.secret).update(`recovery:${code.toLowerCase().replace(/[^a-z2-7]/g, '')}`).digest('hex');
