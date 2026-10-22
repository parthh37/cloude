import { db } from './db.js';

/**
 * Named, idempotent schema extensions for feature modules (worktrees, board,
 * memory, agent CLIs, compression).
 *
 * The core schema in db.ts uses numbered migrations; several branches of Cloude
 * add to that list in parallel, and two branches that both append "migration 2"
 * would silently skip each other's SQL. Feature tables are keyed by name instead,
 * so they apply exactly once regardless of the order branches are merged in.
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

/** Small JSON key/value store for feature settings that don't belong in AppSettings. */
ensureSchema('ext-settings-v1', 'CREATE TABLE ext_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

export const extSettings = {
  get<T>(key: string, fallback: T): T {
    const row = db.prepare('SELECT value FROM ext_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && fallback && typeof fallback === 'object'
        ? ({ ...fallback, ...parsed } as T)
        : (parsed as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    db.prepare('INSERT INTO ext_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  },
};
