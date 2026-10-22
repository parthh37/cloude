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
