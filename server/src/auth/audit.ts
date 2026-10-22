import type { SecurityEvent, SecurityEventType } from '../../../shared/protocol.js';
import { db, now } from '../db.js';

export interface RequestContext {
  ip: string;
  userAgent: string;
}

const DAY = 24 * 60 * 60_000;
/** Failures are what an attacker can generate at will — they get their own, smaller budget. */
const NOISY = `('login_failure', 'mfa_failure', 'lockout', 'reauth_failure')`;

/** Append-only security log: sign-ins, failures, lockouts, and every credential change. */
export function audit(type: SecurityEventType, ctx: RequestContext | null, detail?: Record<string, unknown>) {
  db.prepare('INSERT INTO security_events (type, ip, user_agent, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    type,
    ctx?.ip ?? null,
    ctx?.userAgent.slice(0, 300) ?? null,
    detail ? JSON.stringify(detail) : null,
    now(),
  );
}

export function listSecurityEvents(limit = 100, before?: number): SecurityEvent[] {
  const rows = db
    .prepare('SELECT id, type, ip, user_agent, detail, created_at FROM security_events WHERE id < ? ORDER BY id DESC LIMIT ?')
    .all(before ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 500)) as {
    id: number;
    type: SecurityEventType;
    ip: string | null;
    user_agent: string | null;
    detail: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    ip: r.ip,
    userAgent: r.user_agent,
    detail: r.detail ? JSON.parse(r.detail) : null,
    createdAt: r.created_at,
  }));
}

/** IPv4 /16 or IPv6 /48 as LIKE patterns — "the same network" for new-sign-in alerts. */
function networkPatterns(ip: string): [string, string] {
  const v4 = /(?:^|:)(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return [`${v4[1]}.${v4[2]}.%`, `::ffff:${v4[1]}.${v4[2]}.%`];
  const p = `${ip.split(':').slice(0, 3).join(':')}:%`;
  return [p, p];
}

/** Has this browser, and this network, signed in successfully before? */
export function seenBefore(ctx: RequestContext): { userAgent: boolean; network: boolean } {
  const ok = `type IN ('login_success', 'passkey_login')`;
  return {
    userAgent: !!db.prepare(`SELECT 1 FROM security_events WHERE ${ok} AND user_agent = ? LIMIT 1`).get(ctx.userAgent.slice(0, 300)),
    network: !!db.prepare(`SELECT 1 FROM security_events WHERE ${ok} AND (ip LIKE ? OR ip LIKE ?) LIMIT 1`).get(...networkPatterns(ctx.ip)),
  };
}

export function pruneSecurityEvents() {
  // Sign-ins and credential changes: 180 days. Failures: 30 days and at most 5,000 rows,
  // so a flood of junk logins can't push the important history out.
  db.prepare(`DELETE FROM security_events WHERE type NOT IN ${NOISY} AND created_at < ?`).run(now() - 180 * DAY);
  db.prepare(`DELETE FROM security_events WHERE type IN ${NOISY} AND created_at < ?`).run(now() - 30 * DAY);
  db.prepare(
    `DELETE FROM security_events WHERE type IN ${NOISY} AND id <= (SELECT id FROM security_events WHERE type IN ${NOISY} ORDER BY id DESC LIMIT 1 OFFSET 5000)`,
  ).run();
}
