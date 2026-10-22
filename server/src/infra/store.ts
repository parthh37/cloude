import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';

/**
 * Persistence for the infra module, kept out of db.ts on purpose.
 *
 * db.ts uses a numbered migration list, and parallel branches of Cloude append to
 * it — two branches that both add "migration 2" silently skip each other's SQL.
 * Infra tables are keyed by *name* instead (same `_named_migrations` table and DDL
 * the workbench branch uses, so the two schemes coexist in either merge order).
 */
db.exec('CREATE TABLE IF NOT EXISTS _named_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

export function ensureSchema(name: string, sql: string) {
  if (db.prepare('SELECT 1 FROM _named_migrations WHERE name = ?').get(name)) return;
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _named_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

ensureSchema(
  'infra-v1',
  `
  CREATE TABLE infra_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE infra_sandboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    spec TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    ttl_minutes INTEGER,
    size_bytes INTEGER,
    last_active_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE infra_snapshots (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    label TEXT NOT NULL,
    image TEXT NOT NULL,
    size_bytes INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE infra_cleaner_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    trigger TEXT NOT NULL,
    freed_bytes INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    errors TEXT NOT NULL DEFAULT '[]',
    by_category TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE infra_session_tasks (
    session_id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE infra_routing_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task TEXT NOT NULL,
    source TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    applied INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE infra_chunks (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (project_id, model, path, start_line)
  );
  CREATE INDEX infra_chunks_file ON infra_chunks(project_id, model, path);
  `,
);

/** Small JSON key/value store; object values are shallow-merged over the fallback so new fields get defaults. */
export const kv = {
  get<T>(key: string, fallback: T): T {
    const row = db.prepare('SELECT value FROM infra_kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      const mergeable = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
      return mergeable(parsed) && mergeable(fallback) ? ({ ...fallback, ...parsed } as T) : (parsed as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    db.prepare('INSERT INTO infra_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  },
};

/**
 * Short, stable tag for this Cloude install. Every Docker object Cloude creates
 * carries it (in its name and labels), so two installs sharing one Docker daemon —
 * or Cloude next to your own containers — can never touch each other's resources.
 */
export const INSTANCE = crypto.createHash('sha256').update(config.secret).update('cloude-instance').digest('hex').slice(0, 8);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
