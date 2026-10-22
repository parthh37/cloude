import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// node:sqlite ships with Node >= 22.13 — no native build step, which keeps the
// Docker image simple. All access is synchronous; SQLite is fast enough for a
// single-tenant control plane and the WAL keeps readers unblocked.
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    git_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    model TEXT,
    permission_mode TEXT NOT NULL,
    effort TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    started INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    allowed_tools TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_project ON sessions(project_id, updated_at DESC);
  CREATE TABLE session_events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE services (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    strategy TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '.',
    port INTEGER,
    env TEXT NOT NULL DEFAULT '{}',
    auto_restart INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE routes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    hostname TEXT UNIQUE,
    target_type TEXT NOT NULL,
    port INTEGER,
    static_dir TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE secrets (
    project_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, key)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: hardened sign-in + usage ledger.
  `
  -- Login tokens are now stored as SHA-256 hashes. Old rows hold raw tokens and
  -- can't be converted, so everyone signs in once more.
  DELETE FROM auth_sessions;
  ALTER TABLE auth_sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE auth_sessions ADD COLUMN ip TEXT;
  ALTER TABLE auth_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
  ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN webauthn_id TEXT;
  ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
  CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    name TEXT NOT NULL,
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE login_throttle (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    locked_until INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX security_events_time ON security_events(created_at DESC);

  -- One row per (turn, model): token/cost deltas. No FK on purpose — spend
  -- history outlives deleted sessions and projects.
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_events_time ON usage_events(created_at);
  CREATE INDEX usage_events_session ON usage_events(session_id, created_at);
  -- Last cumulative modelUsage seen per session, for delta accounting. 'legacy'
  -- marks sessions whose transcript already carries totals we can't attribute.
  ALTER TABLE sessions ADD COLUMN usage_snapshot TEXT NOT NULL DEFAULT '{}';
  UPDATE sessions SET usage_snapshot = 'legacy' WHERE started = 1;
  -- Keep historic spend visible in the ledger (attributed to the last activity).
  INSERT INTO usage_events (created_at, session_id, project_id, model, cost_usd)
    SELECT updated_at, id, project_id, COALESCE(model, 'unknown'), total_cost_usd FROM sessions WHERE total_cost_usd > 0;

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

/** Run `fn` inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => Date.now();

/** Small persistent key/value store for server state that isn't a user setting. */
export const kv = {
  get<T>(key: string): T | undefined {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  },
  set(key: string, value: unknown) {
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
      key,
      JSON.stringify(value),
      Date.now(),
    );
  },
};
