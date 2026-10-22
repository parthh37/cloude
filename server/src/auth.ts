import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { hashPassword, newId, randomToken, verifyPassword } from './crypto.js';
import { db, now } from './db.js';

export const SESSION_COOKIE = 'cloude_sid';

export interface AuthUser {
  id: string;
  username: string;
}

/**
 * Create the first admin on boot from CLOUDE_ADMIN_PASSWORD (scripted installs).
 * Without it, the server stays unclaimed and the browser setup wizard creates
 * the account instead — see setup.ts.
 */
export function ensureAdmin() {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) {
    // Allow resetting a forgotten password by setting CLOUDE_ADMIN_PASSWORD and restarting.
    if (config.adminPassword && process.env.CLOUDE_RESET_ADMIN_PASSWORD === 'true') {
      db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hashPassword(config.adminPassword), config.adminUser);
      console.log(`[auth] password for "${config.adminUser}" reset from CLOUDE_ADMIN_PASSWORD`);
    }
    return;
  }
  if (!config.adminPassword) return;
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    newId(),
    config.adminUser,
    hashPassword(config.adminPassword),
    now(),
  );
}

/**
 * Why `password` is unacceptable for the admin account, or null if it's fine.
 * Shown verbatim to the user, so phrase it as advice.
 *
 * Applies to the account created in the setup wizard and to password changes.
 * Remember what this account can do: whoever has it is effectively root on
 * this server (sudo, the Docker socket, every secret), and the login page is
 * on the public internet — rate-limited to 10 tries per IP per 15 minutes.
 */
export function passwordProblem(password: string, username: string): string | null {
  // TODO(you): decide the admin password policy (5-10 lines).
  void username;
  if (password.length < 8) return 'Use at least 8 characters';
  return null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userFromSessionId(sid: string | undefined): AuthUser | null {
  if (!sid) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(sid) as { id: string; username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, username: row.username };
}

export function userFromRaw(req: IncomingMessage): AuthUser | null {
  return userFromSessionId(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

/**
 * Same-origin check for state-changing requests and WebSocket upgrades.
 * Preview apps live on sibling subdomains (same *site*), so SameSite cookies
 * alone don't stop a previewed page from calling the API — the Origin check does.
 */
export function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) don't send Origin
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === config.publicHost || host === effectiveHost(req);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The Host the browser asked for. X-Forwarded-Host is honoured only when the
 * TCP peer is loopback (Caddy on the same machine) — from anyone else it's
 * just a client-controlled header.
 */
export function effectiveHost(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-host'];
  const viaLocalProxy = config.trustProxy && LOOPBACK.has(req.socket.remoteAddress ?? '');
  const raw = (viaLocalProxy && typeof fwd === 'string' && fwd) || req.headers.host || '';
  return raw.split(',')[0]!.trim();
}

/** Same-site relative path safe to redirect to (rejects //host and /\host, which browsers treat as absolute). */
export function isSafeRedirectPath(p: string): boolean {
  return p.startsWith('/') && !/^\/[\\/]/.test(p) && !/[\r\n]/.test(p);
}

const attempts = new Map<string, { count: number; resetAt: number }>();
/** Counts an attempt for `ip`; true once it has made more than 10 in 15 minutes. */
export function rateLimited(ip: string): boolean {
  const entry = attempts.get(ip);
  const t = now();
  if (!entry || entry.resetAt < t) {
    attempts.set(ip, { count: 1, resetAt: t + 15 * 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

/** Sign `userId` in on this browser: create a login session and set its cookie. */
export function startLoginSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const sid = randomToken();
  db.prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    sid,
    userId,
    now(),
    now() + config.sessionTtlMs,
    String(req.headers['user-agent'] ?? '').slice(0, 200),
  );
  reply.setCookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

// preview-auth checks the session itself so it can redirect to /login instead of returning 401.
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/me', '/api/health', '/api/preview-auth', '/api/tls-ask', '/api/setup', '/api/setup/admin']);

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.raw)) {
      return reply.code(403).send({ error: 'Cross-origin request blocked' });
    }
    req.user = userFromSessionId(req.cookies[SESSION_COOKIE]);
    if (!req.user && !PUBLIC_API.has(url)) return reply.code(401).send({ error: 'Not authenticated' });
  });

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts — try again in 15 minutes' });
    const { username, password } = req.body ?? ({} as any);
    const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(String(username ?? '')) as
      | { id: string; username: string; password_hash: string }
      | undefined;
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    attempts.delete(req.ip);
    startLoginSession(req, reply, row.id);
    return { user: { id: row.id, username: row.username } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  app.put<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (req, reply) => {
    const { currentPassword, newPassword } = req.body ?? ({} as any);
    const problem = passwordProblem(String(newPassword ?? ''), req.user!.username);
    if (problem) return reply.code(400).send({ error: problem });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
      return reply.code(403).send({ error: 'Current password is incorrect' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user!.id);
    // Sign out every other device.
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id != ?').run(req.user!.id, req.cookies[SESSION_COOKIE] ?? '');
    return { ok: true };
  });
}

/** Periodically drop expired login sessions. */
export function pruneAuthSessions() {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now());
}
