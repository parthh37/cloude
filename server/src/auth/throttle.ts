import { db, now } from '../db.js';

/**
 * Brute-force protection for every step that checks a secret: password, TOTP,
 * recovery code, passkey, and password re-entry on sensitive settings.
 *
 * Failures are counted under two keys at once — the client IP and the target
 * account — and persisted, so restarting the server doesn't reset them. A key's
 * count decays after a quiet day. A success clears both keys.
 */

export type ThrottleScope = 'ip' | 'account';

const DECAY_MS = 24 * 60 * 60_000;

/**
 * How long to refuse attempts for a key after `failures` consecutive failures
 * (return 0 for "no lock yet"). Called after each failure is recorded.
 *
 * The tension on a single-owner server:
 *   - 'account' locks stop an attacker who rotates IPs (botnets, cloud VMs) from
 *     guessing your password or TOTP code indefinitely…
 *   - …but anyone who knows your username can then lock YOU out on purpose,
 *     and there's no second admin to unlock you.
 *   - 'ip' locks can't be used against you that way, but are cheap to dodge.
 *   - Backoff shape matters: flat ("10 tries, then 15 min") vs. growing
 *     (e.g. doubling) vs. capped. TOTP has only 10^6 codes, so the total
 *     guesses an attacker gets per day is what really counts.
 */
export function lockoutMs(failures: number, scope: ThrottleScope): number {
  // TODO(you): design the lockout curve for each scope (5-10 lines).
  void scope;
  return failures >= 10 ? 15 * 60_000 : 0; // placeholder: Cloude's previous behaviour
}

interface Row {
  key: string;
  failures: number;
  locked_until: number;
  updated_at: number;
}

const keysFor = (ip: string, account: string) =>
  [
    ['ip', `ip:${ip}`],
    ['account', `account:${account.toLowerCase()}`],
  ] as const;

function read(key: string): Row | undefined {
  return db.prepare('SELECT key, failures, locked_until, updated_at FROM login_throttle WHERE key = ?').get(key) as Row | undefined;
}

/** Milliseconds until attempts are allowed again for this ip/account pair (0 = allowed now). */
export function lockedFor(ip: string, account: string): number {
  const t = now();
  let wait = 0;
  for (const [, key] of keysFor(ip, account)) {
    const row = read(key);
    if (row && row.locked_until > t) wait = Math.max(wait, row.locked_until - t);
  }
  return wait;
}

/**
 * Check the lock and count this attempt in one synchronous step, *before* the
 * slow secret check. Counting only after an `await` would let a burst of
 * parallel requests all pass the check before the first failure lands.
 * Returns the lock (ms) that this attempt triggered; a success clears it.
 */
export function beginAttempt(ip: string, account: string): { lockedFor: number; lockMs: number } {
  const wait = lockedFor(ip, account);
  if (wait) return { lockedFor: wait, lockMs: 0 };
  return { lockedFor: 0, lockMs: recordFailure(ip, account) };
}

/** Record a failed attempt. Returns the resulting lock duration (0 if none). */
export function recordFailure(ip: string, account: string): number {
  const t = now();
  let lock = 0;
  for (const [scope, key] of keysFor(ip, account)) {
    const row = read(key);
    const failures = (row && t - row.updated_at < DECAY_MS ? row.failures : 0) + 1;
    const ms = Math.max(0, lockoutMs(failures, scope));
    db.prepare(
      `INSERT INTO login_throttle (key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
    ).run(key, failures, ms ? t + ms : 0, t);
    lock = Math.max(lock, ms);
  }
  return lock;
}

/**
 * Take back the attempt counted by beginAttempt() — for a correct password that
 * still needs a second factor. Neutral, not a reset: otherwise knowing the
 * password would let someone wipe the counter between rounds of 2FA guesses.
 * (The pre-attempt state was unlocked, or beginAttempt would have refused.)
 */
export function undoAttempt(ip: string, account: string) {
  for (const [, key] of keysFor(ip, account)) {
    db.prepare('UPDATE login_throttle SET failures = MAX(0, failures - 1), locked_until = 0 WHERE key = ?').run(key);
  }
}

export function clearFailures(ip: string, account: string) {
  for (const [, key] of keysFor(ip, account)) db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
}

export function pruneThrottle() {
  db.prepare('DELETE FROM login_throttle WHERE updated_at < ? AND locked_until < ?').run(now() - DECAY_MS, now());
}
