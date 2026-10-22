import type { AppSettings, SecretEntry } from '../../shared/protocol.js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { db, now } from './db.js';

const DEFAULTS: AppSettings = {
  defaultModel: 'claude-opus-5-5',
  defaultPermissionMode: 'default',
  defaultEffort: null,
  appendSystemPrompt: '',
  enablePlaywright: true,
  mcpServers: {},
  idleTimeoutMinutes: 30,
};

export const settings = {
  get(): AppSettings {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[r.key] = JSON.parse(r.value);
    return { ...DEFAULTS, ...stored } as AppSettings;
  },
  update(patch: Partial<AppSettings>): AppSettings {
    const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      stmt.run(k, JSON.stringify(v));
    }
    return this.get();
  },
};

/** Keys with special meaning that the UI surfaces in the "Claude account" panel. */
export const AUTH_SECRET_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function mask(v: string) {
  if (v.length <= 8) return '•'.repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export const secrets = {
  list(projectId: string | null): SecretEntry[] {
    const rows = db
      .prepare('SELECT project_id, key, value_enc, updated_at FROM secrets WHERE project_id = ? ORDER BY key')
      .all(projectId ?? '') as { project_id: string; key: string; value_enc: string; updated_at: number }[];
    return rows.map((r) => ({
      key: r.key,
      projectId: r.project_id || null,
      preview: mask(safeDecrypt(r.value_enc)),
      updatedAt: r.updated_at,
    }));
  },
  set(projectId: string | null, key: string, value: string) {
    if (!SECRET_KEY_RE.test(key)) throw new Error('Secret keys must look like ENV_VAR_NAMES');
    db.prepare(
      `INSERT INTO secrets (project_id, key, value_enc, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    ).run(projectId ?? '', key, encrypt(value), now());
  },
  delete(projectId: string | null, key: string) {
    db.prepare('DELETE FROM secrets WHERE project_id = ? AND key = ?').run(projectId ?? '', key);
  },
  values(projectId: string | null): Record<string, string> {
    const rows = db.prepare('SELECT key, value_enc FROM secrets WHERE project_id = ?').all(projectId ?? '') as {
      key: string;
      value_enc: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, safeDecrypt(r.value_enc)]));
  },
};

function safeDecrypt(blob: string) {
  try {
    return decrypt(blob);
  } catch {
    return '';
  }
}

/**
 * The environment every child process (Claude, terminals, services) runs with:
 * the server's own env + global secrets + project secrets (project wins).
 * Note: the Agent SDK's `env` option REPLACES the child env, so this must be a
 * complete environment, not a delta.
 */
export function buildEnv(projectId: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Never leak Cloude's own credentials into user code.
    if (k === 'CLOUDE_ADMIN_PASSWORD' || k === 'CLOUDE_SECRET') continue;
    base[k] = v;
  }
  const merged: Record<string, string> = {
    ...base,
    ...secrets.values(null),
    ...(projectId ? secrets.values(projectId) : {}),
    CLOUDE: '1',
    CLOUDE_PUBLIC_URL: config.publicUrl,
    ...(config.previewDomain ? { CLOUDE_PREVIEW_DOMAIN: config.previewDomain } : {}),
    // Headless server: CLIs must never try to open a local browser.
    BROWSER: 'none',
    ...extra,
  };

  // If a GitHub token is configured, let plain `git` use it over HTTPS without
  // any interactive credential setup (env-only, nothing written to disk).
  const ghToken = merged.GH_TOKEN || merged.GITHUB_TOKEN;
  if (ghToken && !merged.GIT_CONFIG_COUNT) {
    merged.GH_TOKEN = ghToken;
    merged.GIT_CONFIG_COUNT = '1';
    merged.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    merged.GIT_CONFIG_VALUE_0 = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  }
  merged.GIT_TERMINAL_PROMPT = '0';
  return merged;
}
