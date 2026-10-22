import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { encode as encodeQr } from 'uqr';
import type { AuthMethod, LoginResponse, SecurityOverview } from '../../../shared/protocol.js';
import { audit, listSecurityEvents, seenBefore, type RequestContext } from '../auth/audit.js';
import { authenticationOptions, expectedOrigins, passkeys, registrationOptions, verifyAuthentication, verifyRegistration } from '../auth/passkeys.js';
import { beginAttempt, clearFailures, lockedFor, recordFailure, undoAttempt } from '../auth/throttle.js';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { clearSessionCookie, createSession, ctxOf, listDeviceSessions, passwordProblem, revokeOtherSessions, revokeSession } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt, hashPassword, needsRehash, randomToken, verifyPassword } from '../crypto.js';
import { db, now, tx } from '../db.js';
import { hub } from '../hub.js';
import { HttpError } from '../util/paths.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_last_step: number;
  password_changed_at: number | null;
}

const userByName = (username: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow | undefined;
const userById = (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;

/** A real hash of a random password, so unknown usernames cost the same scrypt time as wrong passwords. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(randomToken()));

const MFA_TICKET_TTL = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 5;

function humanWait(ms: number) {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} seconds`;
  if (s < 5400) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.ceil(s / 3600)} hours`;
}

function tooMany(ms: number): never {
  throw Object.assign(new HttpError(429, `Too many attempts — try again in ${humanWait(ms)}`), { retryAfter: Math.ceil(ms / 1000) });
}

/** Short, human description for alerts: "Chrome on macOS". */
export function describeUserAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---- recovery codes ------------------------------------------------------------

function regenerateRecoveryCodes(userId: string): string[] {
  const codes = newRecoveryCodes();
  tx(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, hashRecoveryCode(c));
  });
  return codes;
}

const recoveryLeft = (userId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;

/** Burn a recovery code. Atomic: a code can only ever succeed once. */
const useRecoveryCode = (userId: string, code: string) =>
  db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(now(), userId, hashRecoveryCode(code)).changes === 1;

function factors(user: UserRow) {
  return { totp: !!user.totp_secret_enc, passkey: passkeys.count(user.id) > 0, recovery: recoveryLeft(user.id) > 0 };
}

/** Recovery codes only make sense while some second factor exists. */
function dropRecoveryCodesIfUnused(userId: string) {
  const u = userById(userId);
  if (!u.totp_secret_enc && passkeys.count(userId) === 0) db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
}

// ---- second-factor tickets ---------------------------------------------------------
// Issued after a correct password when 2FA is on. Holds no privileges by itself.

interface MfaTicket {
  userId: string;
  username: string;
  exp: number;
  attempts: number;
  passkeyChallengeId?: string;
}
const tickets = new Map<string, MfaTicket>();

function newTicket(user: UserRow): string {
  for (const [k, v] of tickets) if (v.exp < now()) tickets.delete(k);
  const id = crypto.randomBytes(24).toString('base64url');
  tickets.set(id, { userId: user.id, username: user.username, exp: now() + MFA_TICKET_TTL, attempts: 0 });
  return id;
}

function getTicket(id: unknown): MfaTicket & { id: string } {
  const key = String(id ?? '');
  const t = tickets.get(key);
  if (!t || t.exp < now()) {
    tickets.delete(key);
    throw new HttpError(401, 'Sign-in timed out — enter your password again');
  }
  return Object.assign(t, { id: key });
}

/** Count a failed second factor against the ticket and the throttle. */
function failSecondFactor(req: FastifyRequest, t: MfaTicket & { id: string }, method: AuthMethod): never {
  const ctx = ctxOf(req);
  t.attempts++;
  if (t.attempts >= MFA_MAX_ATTEMPTS) tickets.delete(t.id);
  const lock = recordFailure(ctx.ip, t.username);
  audit('mfa_failure', ctx, { method, username: t.username });
  if (lock) audit('lockout', ctx, { username: t.username, ms: lock });
  throw new HttpError(401, t.attempts >= MFA_MAX_ATTEMPTS ? 'Too many wrong codes — enter your password again' : 'That code is not valid');
}

// ---- finishing a sign-in -------------------------------------------------------------

function finishLogin(req: FastifyRequest, reply: FastifyReply, user: Pick<UserRow, 'id' | 'username'>, method: AuthMethod): LoginResponse {
  const ctx = ctxOf(req);
  clearFailures(ctx.ip, user.username);
  // Alert when either the browser or the network is new — a copied user-agent alone won't hide a login.
  const seen = seenBefore(ctx);
  const newDevice = !seen.userAgent || !seen.network;
  createSession(reply, user.id, ctx, method);
  audit(method === 'passkey' ? 'passkey_login' : 'login_success', ctx, { method, newDevice });
  if (newDevice) {
    hub.broadcast({ t: 'notify', level: 'warning', title: 'New sign-in to Cloude', body: `${describeUserAgent(ctx.userAgent)} · ${ctx.ip}` });
  }
  return { user: { id: user.id, username: user.username } };
}

// scrypt costs 32 MiB and runs on the shared libuv pool: cap how many run at once,
// so a burst of logins can't starve file I/O for everyone else.
const scryptBusy = new Map<string, number>();
let scryptTotal = 0;
async function withScryptSlot<T>(ip: string, fn: () => Promise<T>): Promise<T> {
  const mine = scryptBusy.get(ip) ?? 0;
  if (mine >= 2 || scryptTotal >= 16) throw new HttpError(429, 'Too many sign-in attempts at once — try again in a moment');
  scryptBusy.set(ip, mine + 1);
  scryptTotal++;
  try {
    return await fn();
  } finally {
    scryptTotal--;
    const left = (scryptBusy.get(ip) ?? 1) - 1;
    if (left > 0) scryptBusy.set(ip, left);
    else scryptBusy.delete(ip);
  }
}

/**
 * Check a password with brute-force accounting. The attempt is counted *before*
 * the slow hash (see beginAttempt) — the caller clears it on success.
 */
async function checkPassword(ctx: RequestContext, account: string, password: string, hash: string): Promise<{ ok: boolean; lockMs: number }> {
  const wait = lockedFor(ctx.ip, account);
  if (wait) tooMany(wait);
  return withScryptSlot(ctx.ip, async () => {
    const attempt = beginAttempt(ctx.ip, account);
    if (attempt.lockedFor) tooMany(attempt.lockedFor);
    return { ok: await verifyPassword(password, hash), lockMs: attempt.lockMs };
  });
}

/** Re-enter the password before changing credentials, so a hijacked tab can't lock you out or add its own passkey. */
async function reauth(req: FastifyRequest, password: unknown): Promise<UserRow> {
  const ctx = ctxOf(req);
  const me = req.user!;
  const row = userById(me.id);
  const { ok, lockMs } = await checkPassword(ctx, me.username, String(password ?? '').slice(0, 1024), row.password_hash);
  if (!ok) {
    audit('reauth_failure', ctx);
    if (lockMs) audit('lockout', ctx, { username: me.username, ms: lockMs });
    throw new HttpError(403, 'Password is incorrect');
  }
  clearFailures(ctx.ip, me.username);
  return row;
}

const pendingTotp = new Map<string, { secret: string; exp: number }>();

export function registerAuthRoutes(app: FastifyInstance) {
  // ---- sign in ----
  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply): Promise<LoginResponse> => {
    const ctx = ctxOf(req);
    const username = String(req.body?.username ?? '').trim().slice(0, 100);
    const password = String(req.body?.password ?? '').slice(0, 1024);
    const row = username ? userByName(username) : undefined;
    const hash = row?.password_hash ?? (await dummy());
    const { ok, lockMs } = await checkPassword(ctx, username || '-', password, hash);
    if (!row || !ok) {
      // Log the typed name only when it's a real account — people paste passwords into the username box.
      const who = row ? { username } : { unknownUser: true };
      audit('login_failure', ctx, who);
      if (lockMs) audit('lockout', ctx, { ...who, ms: lockMs });
      throw new HttpError(401, 'Invalid username or password');
    }
    if (needsRehash(row.password_hash)) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), row.id);

    const f = factors(row);
    if (f.totp || f.passkey) {
      undoAttempt(ctx.ip, username);
      return { mfa: { ticket: newTicket(row), methods: f } };
    }
    return finishLogin(req, reply, row, 'password');
  });

  app.post<{ Body: { ticket?: string; method?: 'totp' | 'recovery'; code?: string } }>('/api/auth/mfa', async (req, reply) => {
    const t = getTicket(req.body?.ticket);
    const wait = lockedFor(ctxOf(req).ip, t.username);
    if (wait) tooMany(wait);
    const code = String(req.body?.code ?? '').slice(0, 64);
    const method: AuthMethod = req.body?.method === 'recovery' ? 'recovery' : 'totp';
    // No awaits between reading totp_last_step and writing it: a code can't be replayed concurrently.
    const row = userById(t.userId);
    if (method === 'recovery') {
      if (!useRecoveryCode(row.id, code)) failSecondFactor(req, t, method);
      audit('recovery_code_used', ctxOf(req), { remaining: recoveryLeft(row.id) });
    } else {
      const step = row.totp_secret_enc ? verifyTotp(decrypt(row.totp_secret_enc), code, row.totp_last_step) : null;
      if (step === null) failSecondFactor(req, t, method);
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
    }
    tickets.delete(t.id);
    return finishLogin(req, reply, row, method);
  });

  app.post<{ Body: { ticket?: string } }>('/api/auth/mfa/passkey/options', async (req) => {
    const t = getTicket(req.body?.ticket);
    const { options, challengeId } = await authenticationOptions(t.userId, ctxOf(req).ip);
    t.passkeyChallengeId = challengeId;
    return { options };
  });

  app.post<{ Body: { ticket?: string; response?: AuthenticationResponseJSON } }>('/api/auth/mfa/passkey', async (req, reply) => {
    const t = getTicket(req.body?.ticket);
    const wait = lockedFor(ctxOf(req).ip, t.username);
    if (wait) tooMany(wait);
    if (!t.passkeyChallengeId || !req.body?.response) throw new HttpError(400, 'Start the passkey prompt first');
    let userId: string;
    try {
      ({ userId } = await verifyAuthentication(t.passkeyChallengeId, req.body.response, expectedOrigins(req.headers.origin)));
    } catch {
      failSecondFactor(req, t, 'passkey');
    }
    if (userId !== t.userId) failSecondFactor(req, t, 'passkey');
    tickets.delete(t.id);
    return finishLogin(req, reply, userById(userId), 'passkey');
  });

  // Passwordless: a passkey with user verification is already two factors (device + biometric/PIN).
  // No lockout here: signatures can't be guessed, and a shared bucket would only let anyone block passkey sign-in.
  // Pending challenges are capped per IP instead (passkeys.ts).
  app.post('/api/auth/passkey/options', async (req) => authenticationOptions(null, ctxOf(req).ip));

  app.post<{ Body: { challengeId?: string; response?: AuthenticationResponseJSON } }>('/api/auth/passkey', async (req, reply) => {
    const ctx = ctxOf(req);
    try {
      const { userId } = await verifyAuthentication(String(req.body?.challengeId ?? ''), req.body?.response as AuthenticationResponseJSON, expectedOrigins(req.headers.origin));
      return finishLogin(req, reply, userById(userId), 'passkey');
    } catch (e) {
      audit('login_failure', ctx, { method: 'passkey' });
      throw e;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.authSid) {
      revokeSession(req.authSid);
      audit('logout', ctxOf(req));
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  // ---- account security ----
  app.get('/api/auth/security', async (req): Promise<SecurityOverview> => {
    const row = userById(req.user!.id);
    return {
      totp: !!row.totp_secret_enc,
      recoveryCodesLeft: recoveryLeft(row.id),
      passkeys: passkeys.list(row.id),
      sessions: listDeviceSessions(row.id, req.authSid),
      passwordChangedAt: row.password_changed_at,
    };
  });

  app.get<{ Querystring: { limit?: string; before?: string } }>('/api/auth/events', async (req) => ({
    events: listSecurityEvents(Number(req.query.limit ?? 100), req.query.before ? Number(req.query.before) : undefined),
  }));

  app.put<{ Body: { currentPassword?: string; newPassword?: string } }>('/api/auth/password', async (req) => {
    const next = String(req.body?.newPassword ?? '');
    const problem = passwordProblem(next, req.user!.username);
    if (problem) throw new HttpError(400, problem);
    const row = await reauth(req, req.body?.currentPassword);
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(next), now(), row.id);
    const signedOut = revokeOtherSessions(row.id, req.authSid);
    audit('password_changed', ctxOf(req), { signedOut });
    return { ok: true, signedOut };
  });

  // ---- devices ----
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req, reply) => {
    const owned = db.prepare('SELECT 1 FROM auth_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.id);
    if (!owned) throw new HttpError(404, 'That device is already signed out');
    const current = req.params.id === req.authSid;
    revokeSession(req.params.id);
    audit('session_revoked', ctxOf(req), { session: req.params.id.slice(0, 8), current });
    if (current) clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const signedOut = revokeOtherSessions(req.user!.id, req.authSid);
    audit('session_revoked', ctxOf(req), { others: signedOut });
    return { ok: true, signedOut };
  });

  // ---- authenticator app (TOTP) ----
  app.post('/api/auth/totp/setup', async (req) => {
    const row = userById(req.user!.id);
    if (row.totp_secret_enc) throw new HttpError(409, 'Two-factor authentication is already on');
    const secret = newTotpSecret();
    pendingTotp.set(row.id, { secret, exp: now() + 10 * 60_000 });
    const uri = otpauthUrl(secret, `${row.username}@${new URL(config.publicUrl).hostname}`, 'Cloude');
    return { secret, uri, qr: encodeQr(uri, { ecc: 'M', border: 2 }).data };
  });

  app.post<{ Body: { code?: string; password?: string } }>('/api/auth/totp/enable', async (req) => {
    const row = await reauth(req, req.body?.password);
    const pending = pendingTotp.get(row.id);
    if (!pending || pending.exp < now()) throw new HttpError(400, 'Setup expired — start again');
    const step = verifyTotp(pending.secret, String(req.body?.code ?? ''), 0);
    if (step === null) throw new HttpError(400, "That code doesn't match. Check the time on your phone is set automatically.");
    db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = ? WHERE id = ?').run(encrypt(pending.secret), step, row.id);
    pendingTotp.delete(row.id);
    const recoveryCodes = regenerateRecoveryCodes(row.id);
    // Logins created before 2FA was on never proved a second factor.
    const signedOut = revokeOtherSessions(row.id, req.authSid);
    audit('totp_enabled', ctxOf(req), { signedOut });
    return { recoveryCodes, signedOut };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/totp/disable', async (req) => {
    const row = await reauth(req, req.body?.password);
    db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?').run(row.id);
    dropRecoveryCodesIfUnused(row.id);
    audit('totp_disabled', ctxOf(req));
    return { ok: true };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/recovery-codes', async (req) => {
    const row = await reauth(req, req.body?.password);
    const f = factors(row);
    if (!f.totp && !f.passkey) throw new HttpError(400, 'Turn on two-factor authentication or add a passkey first');
    const recoveryCodes = regenerateRecoveryCodes(row.id);
    audit('recovery_codes_generated', ctxOf(req));
    return { recoveryCodes };
  });

  // ---- passkeys ----
  app.post<{ Body: { password?: string } }>('/api/auth/passkeys/options', async (req) => {
    const row = await reauth(req, req.body?.password);
    return registrationOptions(row, ctxOf(req).ip);
  });

  app.post<{ Body: { challengeId?: string; response?: RegistrationResponseJSON; name?: string } }>('/api/auth/passkeys', async (req) => {
    const me = req.user!;
    if (!req.body?.response) throw new HttpError(400, 'Missing passkey response');
    const passkey = await verifyRegistration(me.id, String(req.body.challengeId ?? ''), req.body.response, String(req.body.name ?? ''), expectedOrigins(req.headers.origin));
    // First second factor? Hand out recovery codes so a lost device isn't a lost server, and
    // sign out logins that never proved a second factor (same as turning on TOTP).
    const first = !userById(me.id).totp_secret_enc && passkeys.count(me.id) === 1;
    const recoveryCodes = recoveryLeft(me.id) === 0 ? regenerateRecoveryCodes(me.id) : undefined;
    const signedOut = first ? revokeOtherSessions(me.id, req.authSid) : 0;
    audit('passkey_added', ctxOf(req), { name: passkey.name, signedOut });
    return { passkey, recoveryCodes, signedOut };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/auth/passkeys/:id', async (req) => {
    passkeys.rename(req.user!.id, req.params.id, String(req.body?.name ?? ''));
    return { ok: true };
  });

  // Removing a passkey can drop the account to password-only, so it needs the password too.
  app.post<{ Params: { id: string }; Body: { password?: string } }>('/api/auth/passkeys/:id/remove', async (req) => {
    await reauth(req, req.body?.password);
    const removed = passkeys.remove(req.user!.id, req.params.id);
    dropRecoveryCodesIfUnused(req.user!.id);
    audit('passkey_removed', ctxOf(req), { name: removed.name });
    return { ok: true };
  });
}
