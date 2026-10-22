import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Passkey } from '../../../shared/protocol.js';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { HttpError } from '../util/paths.js';

/**
 * WebAuthn passkeys (Face ID / Touch ID / Windows Hello / security keys).
 *
 * rpID is Cloude's hostname. Preview apps live on *subdomains* of it, and the
 * WebAuthn spec lets a subdomain request assertions for a parent rpID — so the
 * real protection is pinning the exact expected origin, which the browser
 * writes into clientDataJSON and page script cannot forge.
 */

const rpID = () => new URL(config.publicUrl).hostname;

/** Origins whose WebAuthn ceremonies we accept. Over plain http (local dev) the Vite origin is allowed too. */
export function expectedOrigins(requestOrigin: string | undefined): string[] {
  const canonical = new URL(config.publicUrl).origin;
  if (config.secure || !requestOrigin) return [canonical];
  try {
    const o = new URL(requestOrigin);
    return o.hostname === rpID() ? [canonical, o.origin] : [canonical];
  } catch {
    return [canonical];
  }
}

// ---- single-use challenges -------------------------------------------------------

interface Challenge {
  challenge: string;
  purpose: 'register' | 'login';
  userId: string | null;
  ip: string;
  exp: number;
}
const challenges = new Map<string, Challenge>(); // insertion order = age
const CHALLENGE_TTL = 5 * 60_000;
const PER_IP = 10;
const TOTAL = 5000;

/**
 * Pending challenges are capped per IP; at a cap the *oldest* is evicted rather
 * than refusing, so one client (or a crowd) can't block everyone's passkey prompt.
 */
function putChallenge(c: Omit<Challenge, 'exp'>): string {
  const t = now();
  const mine: string[] = [];
  for (const [k, v] of challenges) {
    if (v.exp < t) challenges.delete(k);
    else if (v.ip === c.ip) mine.push(k);
  }
  while (mine.length >= PER_IP) challenges.delete(mine.shift()!);
  while (challenges.size >= TOTAL) challenges.delete(challenges.keys().next().value!);
  const id = crypto.randomBytes(18).toString('base64url');
  challenges.set(id, { ...c, exp: t + CHALLENGE_TTL });
  return id;
}

function takeChallenge(id: string, purpose: Challenge['purpose']): Challenge {
  const c = challenges.get(String(id));
  challenges.delete(String(id));
  if (!c || c.exp < now() || c.purpose !== purpose) throw new HttpError(400, 'Passkey request expired — try again');
  return c;
}

// ---- storage ---------------------------------------------------------------------

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  name: r.name,
  deviceType: r.device_type === 'multiDevice' ? 'synced' : 'device-bound',
  backedUp: !!r.backed_up,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export const passkeys = {
  list(userId: string): Passkey[] {
    return (db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as PasskeyRow[]).map(toPasskey);
  },
  count(userId: string): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId) as { n: number }).n;
  },
  rename(userId: string, id: string, name: string) {
    const r = db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(name.trim().slice(0, 60) || 'Passkey', id, userId);
    if (!r.changes) throw new HttpError(404, 'Passkey not found');
  },
  remove(userId: string, id: string): Passkey {
    const row = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(id, userId) as PasskeyRow | undefined;
    if (!row) throw new HttpError(404, 'Passkey not found');
    db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    return toPasskey(row);
  },
};

function webauthnUserId(userId: string): string {
  const row = db.prepare('SELECT webauthn_id FROM users WHERE id = ?').get(userId) as { webauthn_id: string | null };
  if (row.webauthn_id) return row.webauthn_id;
  // A random handle, not the username: authenticators may expose it, so it must carry no PII.
  const handle = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET webauthn_id = ? WHERE id = ?').run(handle, userId);
  return handle;
}

// ---- registration ----------------------------------------------------------------

export async function registrationOptions(user: { id: string; username: string }, ip: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
  const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id) as { id: string; transports: string }[];
  const options = await generateRegistrationOptions({
    rpName: 'Cloude',
    rpID: rpID(),
    userName: user.username,
    userDisplayName: `${user.username} @ ${config.publicHost}`,
    userID: Buffer.from(webauthnUserId(user.id), 'base64url'),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { options, challengeId: putChallenge({ challenge: options.challenge, purpose: 'register', userId: user.id, ip }) };
}

export async function verifyRegistration(
  userId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
  origins: string[],
): Promise<Passkey> {
  const c = takeChallenge(challengeId, 'register');
  if (c.userId !== userId) throw new HttpError(400, 'Passkey request does not match this account');
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: origins,
    expectedRPID: rpID(),
    requireUserVerification: true,
  }).catch((e: Error) => {
    throw new HttpError(400, `Passkey not accepted: ${e.message}`);
  });
  if (!result.verified) throw new HttpError(400, 'Passkey could not be verified');
  const info = result.registrationInfo;
  const row: PasskeyRow = {
    id: info.credential.id,
    user_id: userId,
    public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    transports: JSON.stringify(info.credential.transports ?? []),
    name: name.trim().slice(0, 60) || 'Passkey',
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    created_at: now(),
    last_used_at: null,
  };
  db.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, device_type, backed_up, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.user_id, row.public_key, row.counter, row.transports, row.name, row.device_type, row.backed_up, row.created_at);
  return toPasskey(row);
}

// ---- authentication --------------------------------------------------------------

/** userId = null: usernameless sign-in (the authenticator picks a discoverable credential). */
export async function authenticationOptions(userId: string | null, ip: string): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
  const allow = userId ? (db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId) as { id: string; transports: string }[]) : [];
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: allow.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    userVerification: 'required',
  });
  return { options, challengeId: putChallenge({ challenge: options.challenge, purpose: 'login', userId, ip }) };
}

/** Returns the user the passkey belongs to, or throws. */
export async function verifyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
  origins: string[],
): Promise<{ userId: string; passkey: Passkey }> {
  const c = takeChallenge(challengeId, 'login');
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(response?.id ?? '')) as PasskeyRow | undefined;
  if (!row || (c.userId && row.user_id !== c.userId)) throw new HttpError(401, 'This passkey is not registered with Cloude');
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: origins,
    expectedRPID: rpID(),
    requireUserVerification: true,
    credential: {
      id: row.id,
      publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
      counter: row.counter,
      transports: JSON.parse(row.transports),
    },
  }).catch((e: Error) => {
    throw new HttpError(401, `Passkey not accepted: ${e.message}`);
  });
  if (!result.verified) throw new HttpError(401, 'Passkey could not be verified');
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?').run(
    result.authenticationInfo.newCounter,
    now(),
    result.authenticationInfo.credentialBackedUp ? 1 : 0,
    row.id,
  );
  return { userId: row.user_id, passkey: toPasskey({ ...row, last_used_at: now() }) };
}
