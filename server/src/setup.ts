import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SetupStatus } from '../../shared/protocol.js';
import type { AuthUser } from './auth.js';
import { passwordProblem } from './auth.js';
import { audit, type RequestContext } from './auth/audit.js';
import { beginAttempt, clearFailures } from './auth/throttle.js';
import { config } from './config.js';
import { hashPassword, newId, randomToken } from './crypto.js';
import { db, now } from './db.js';
import { HttpError } from './util/paths.js';

/**
 * First-run setup.
 *
 * A fresh server has no account. Rather than printing a generated password to
 * the log, Cloude serves a setup wizard at /setup and whoever finishes its first
 * step becomes the admin. That account is root-equivalent on this machine, so
 * claiming it needs a one-time setup code that only someone with access to the
 * server can know: install.sh prints it as a link, the server log prints it, and
 * it's saved in the data directory.
 */

const TOKEN_FILE = path.join(config.dataDir, 'setup-token.txt');
const COMPLETED_KEY = 'setup.completedAt'; // internal row in the settings table

let setupToken: string | null = null;

const count = (table: 'users' | 'projects') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

export const needsAdmin = () => count('users') === 0;

export function isSetupCompleted(): boolean {
  return !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(COMPLETED_KEY);
}

export function markSetupCompleted() {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(COMPLETED_KEY, JSON.stringify(now()));
}

export function setupStatus(): SetupStatus {
  return { needsAdmin: needsAdmin(), completed: isSetupCompleted() };
}

/** Run on boot, after ensureAdmin(). Loads (or mints) the setup code when the server is unclaimed. */
export function initSetup() {
  if (!needsAdmin()) {
    // Servers set up before the wizard existed are already in use — don't send them through it.
    if (!isSetupCompleted() && count('projects') > 0) markSetupCompleted();
    fs.rmSync(TOKEN_FILE, { force: true });
    return;
  }
  // Prefer the code install.sh put in .env, then one from a previous boot (so a link
  // printed earlier keeps working across restarts), else mint a new one.
  setupToken = process.env.CLOUDE_SETUP_TOKEN?.trim() || readTokenFile() || randomToken(18);
  fs.writeFileSync(TOKEN_FILE, `${setupToken}\n`, { mode: 0o600 });
}

function readTokenFile(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Link that opens the wizard with the code filled in. The #fragment never reaches proxy logs. */
export const setupUrl = () => (setupToken ? `${config.publicUrl}/setup#code=${setupToken}` : null);

export function printSetupBanner() {
  const url = setupUrl();
  if (!url) return;
  console.log('\n' + '='.repeat(72));
  console.log(' Finish setting up Cloude in your browser:');
  console.log(`   ${url}`);
  console.log(`\n Setup code: ${setupToken}   (also in ${TOKEN_FILE})`);
  console.log('='.repeat(72) + '\n');
}

function codeMatches(provided: string): boolean {
  if (!setupToken) return false;
  // Hash both sides so the comparison is constant-time even when lengths differ.
  const a = crypto.createHash('sha256').update(provided.trim()).digest();
  const b = crypto.createHash('sha256').update(setupToken).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Throttle key for setup-code guesses. Parentheses can't appear in a username, so it never collides with one. */
const THROTTLE_ACCOUNT = '(setup)';

/**
 * Create the admin account. The slow hash runs first; after it, the "still
 * unclaimed?" re-check and the INSERT happen with no `await` in between, so two
 * racing requests can't both claim.
 */
export async function claimAdmin(code: string, username: string, password: string, ctx: RequestContext): Promise<AuthUser> {
  if (!needsAdmin()) throw new HttpError(409, 'This server is already set up. Sign in instead.');
  // Count the guess before anything else (see auth/throttle.ts).
  const attempt = beginAttempt(ctx.ip, THROTTLE_ACCOUNT);
  if (attempt.lockedFor) throw new HttpError(429, 'Too many wrong setup codes. Try again later.');
  if (!codeMatches(code)) {
    audit('login_failure', ctx, { method: 'setup' });
    if (attempt.lockMs) audit('lockout', ctx, { username: THROTTLE_ACCOUNT, ms: attempt.lockMs });
    throw new HttpError(403, "That setup code isn't right. Use the link from the installer or the server log.");
  }
  clearFailures(ctx.ip, THROTTLE_ACCOUNT);

  const name = username.trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new HttpError(400, 'Usernames use letters, numbers, dots, dashes and underscores (up to 32)');
  const problem = passwordProblem(password, name);
  if (problem) throw new HttpError(400, problem);
  const hash = await hashPassword(password);

  // No await from here on: another claim may have won while we were hashing.
  if (!needsAdmin() || !setupToken) throw new HttpError(409, 'This server is already set up. Sign in instead.');
  const user = { id: newId(), username: name };
  const t = now();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)').run(user.id, name, hash, t, t);
  setupToken = null;
  fs.rmSync(TOKEN_FILE, { force: true });
  audit('account_created', ctx, { username: name });
  console.log(`[setup] admin account "${name}" created from the browser`);
  return user;
}
