import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthMethod, AuthUser, DeviceSession } from '../../shared/protocol.js';
import type { RequestContext } from './auth/audit.js';
import { config } from './config.js';
import { hashPassword, newId, randomToken, sha256 } from './crypto.js';
import { db, now } from './db.js';
import { settings } from './settings.js';

export type { AuthUser };

/**
 * `__Host-` cookies must be Secure, Path=/ and have no Domain — so a preview app
 * on a sibling subdomain can't plant or overwrite Cloude's session cookie
 * (session fixation / cookie tossing). Plain http (local dev) can't use the prefix.
 */
export const SESSION_COOKIE = config.secure ? '__Host-cloude_sid' : 'cloude_sid';
export const SESSION_COOKIE_NAMES = ['cloude_sid', '__Host-cloude_sid'];

const DAY = 24 * 60 * 60_000;
/** Don't write last_seen_at on every request. */
const TOUCH_EVERY_MS = 60_000;

/** Create the first admin on boot. Password from env, else generated and logged once. */
export async function ensureAdmin() {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) {
    // Allow resetting a forgotten password by setting CLOUDE_ADMIN_PASSWORD and restarting.
    if (config.adminPassword && process.env.CLOUDE_RESET_ADMIN_PASSWORD === 'true') {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE username = ?').run(
        await hashPassword(config.adminPassword),
        now(),
        config.adminUser,
      );
      db.prepare('DELETE FROM auth_sessions').run();
      console.log(`[auth] password for "${config.adminUser}" reset from CLOUDE_ADMIN_PASSWORD; all devices signed out`);
    }
    // Last resort when the authenticator, passkeys AND recovery codes are all lost.
    // Deliberately server-side only: a web path to remove 2FA would defeat 2FA.
    if (process.env.CLOUDE_RESET_ADMIN_2FA === 'true') {
      const u = db.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUser) as { id: string } | undefined;
      if (u) {
        db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?').run(u.id);
        db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(u.id);
        db.prepare("INSERT INTO security_events (type, detail, created_at) VALUES ('totp_disabled', ?, ?)").run(JSON.stringify({ via: 'CLOUDE_RESET_ADMIN_2FA' }), now());
        console.log(`[auth] 2FA and passkeys removed for "${config.adminUser}" (CLOUDE_RESET_ADMIN_2FA); unset it and restart`);
      }
    }
    return;
  }
  const password = config.adminPassword ?? randomToken(12);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)').run(
    newId(),
    config.adminUser,
    await hashPassword(password),
    now(),
    now(),
  );
  if (!config.adminPassword) {
    const file = path.join(config.dataDir, 'initial-admin-password.txt');
    fs.writeFileSync(file, `${config.adminUser}\n${password}\n`, { mode: 0o600 });
    console.log('\n' + '='.repeat(64));
    console.log(` Cloude admin account created`);
    console.log(`   username: ${config.adminUser}`);
    console.log(`   password: ${password}`);
    console.log(`   (also saved to ${file} — change it in Security)`);
    console.log('='.repeat(64) + '\n');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed value — ignore the cookie */
    }
  }
  return out;
}

// ---- login sessions -------------------------------------------------------------

export interface Auth {
  user: AuthUser;
  /** auth_sessions.id = SHA-256 of the cookie token. A database leak doesn't hand out live logins. */
  sid: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  username: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  auth_method: AuthMethod;
}

const idleMs = () => settings.get().sessionIdleDays * DAY;
const isExpired = (r: Pick<SessionRow, 'expires_at' | 'last_seen_at'>, t = now()) => r.expires_at < t || r.last_seen_at + idleMs() < t;

export function authFromToken(token: string | undefined): Auth | null {
  if (!token || token.length > 128) return null;
  const sid = sha256(token);
  const row = db
    .prepare('SELECT s.expires_at, s.last_seen_at, u.id, u.username FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(sid) as { expires_at: number; last_seen_at: number; id: string; username: string } | undefined;
  if (!row) return null;
  const t = now();
  if (isExpired(row, t)) {
    revokeSession(sid);
    return null;
  }
  if (t - row.last_seen_at > TOUCH_EVERY_MS) db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(t, sid);
  return { user: { id: row.id, username: row.username }, sid };
}

export const authFromRaw = (req: IncomingMessage) => authFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
export const userFromRaw = (req: IncomingMessage) => authFromRaw(req)?.user ?? null;

/** For credentials derived from a login (preview cookies): is that login still valid? */
export function isSessionAlive(sid: string): boolean {
  const row = db.prepare('SELECT expires_at, last_seen_at FROM auth_sessions WHERE id = ?').get(sid) as
    | Pick<SessionRow, 'expires_at' | 'last_seen_at'>
    | undefined;
  return !!row && !isExpired(row);
}

export function createSession(reply: FastifyReply, userId: string, ctx: RequestContext, method: AuthMethod): string {
  const token = randomToken();
  const sid = sha256(token);
  const t = now();
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip, auth_method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sid, userId, t, t + config.sessionTtlMs, t, ctx.userAgent.slice(0, 300), ctx.ip, method);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secure,
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
  return sid;
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.secure, httpOnly: true, sameSite: 'lax' });
}

export function listDeviceSessions(userId: string, currentSid: string | null): DeviceSession[] {
  const rows = db
    .prepare('SELECT s.*, u.username FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? ORDER BY s.last_seen_at DESC')
    .all(userId) as unknown as SessionRow[];
  return rows
    .filter((r) => !isExpired(r))
    .map((r) => ({
      id: r.id,
      current: r.id === currentSid,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: Math.min(r.expires_at, r.last_seen_at + idleMs()),
      ip: r.ip,
      userAgent: r.user_agent,
      method: r.auth_method,
    }));
}

// ---- live sockets per login -------------------------------------------------------
// A revoked or expired login must also lose its open WebSockets (event stream,
// terminals) — otherwise "sign out that device" leaves a stolen tab connected.

interface Closable {
  close(code?: number, reason?: string): void;
  terminate(): void;
  pause(): void;
  once(event: 'close', fn: () => void): unknown;
}
const sockets = new Map<string, Set<Closable>>();

export function trackSocket(sid: string, ws: Closable) {
  let set = sockets.get(sid);
  if (!set) sockets.set(sid, (set = new Set()));
  set.add(ws);
  ws.once('close', () => {
    set!.delete(ws);
    if (set!.size === 0 && sockets.get(sid) === set) sockets.delete(sid);
  });
}

function closeSockets(sid: string) {
  const set = sockets.get(sid);
  if (!set) return;
  sockets.delete(sid);
  for (const ws of set) {
    // close() alone only starts a handshake and keeps delivering messages until the
    // peer answers (or 30 s pass) — a stolen tab could keep typing into a terminal.
    // Stop reading now, tell an honest client why, then cut the connection.
    ws.pause();
    ws.close(4401, 'Signed out');
    setTimeout(() => ws.terminate(), 500).unref();
  }
}

export function revokeSession(sid: string) {
  db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sid);
  closeSockets(sid);
}

export function revokeOtherSessions(userId: string, keepSid: string | null): number {
  const ids = db.prepare('SELECT id FROM auth_sessions WHERE user_id = ? AND id != ?').all(userId, keepSid ?? '') as { id: string }[];
  for (const { id } of ids) revokeSession(id);
  return ids.length;
}

/** Periodically drop expired logins (absolute or idle) and disconnect their sockets. */
export function pruneAuthSessions() {
  const rows = db.prepare('SELECT id, expires_at, last_seen_at FROM auth_sessions').all() as Pick<SessionRow, 'id' | 'expires_at' | 'last_seen_at'>[];
  for (const r of rows) if (isExpired(r)) revokeSession(r.id);
  for (const sid of [...sockets.keys()]) if (!isSessionAlive(sid)) closeSockets(sid);
}

// ---- request plumbing ---------------------------------------------------------------

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

export const ctxOf = (req: FastifyRequest): RequestContext => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authSid: string | null;
  }
}

// preview-auth checks the session itself so it can redirect to /login instead of returning 401.
const PUBLIC_API = new Set([
  '/api/auth/login',
  '/api/auth/mfa',
  '/api/auth/mfa/passkey/options',
  '/api/auth/mfa/passkey',
  '/api/auth/passkey/options',
  '/api/auth/passkey',
  '/api/auth/me',
  '/api/health',
  '/api/preview-auth',
  '/api/tls-ask',
]);

function contentSecurityPolicy(): string {
  const ws = config.publicUrl.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror, xterm and highlight.js set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${ws}`,
    // App previews are iframed from their own (sub)domains.
    "frame-src 'self' https: http:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('authSid', null);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Decide on the route the router actually matched, never on the raw URL: the
    // router percent-decodes paths, so "/%61pi/secrets" reaches the "/api/secrets"
    // handler while a raw-string check would wave it through.
    const route = req.routeOptions.url;
    // No match → the not-found handler (404 / SPA index.html), no API handler runs.
    // Every route outside /api/ is the public static UI.
    if (route === undefined || !route.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.raw)) {
      return reply.code(403).send({ error: 'Cross-origin request blocked' });
    }
    const auth = authFromToken(req.cookies[SESSION_COOKIE]);
    req.user = auth?.user ?? null;
    req.authSid = auth?.sid ?? null;
    if (!req.user && !PUBLIC_API.has(route)) return reply.code(401).send({ error: 'Not authenticated' });
  });

  // Cloude's own responses only — previews are served before Fastify and keep their own headers.
  const csp = contentSecurityPolicy();
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (config.secure) reply.header('strict-transport-security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) {
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    } else {
      reply.header('content-security-policy', csp);
    }
    return payload;
  });
}
