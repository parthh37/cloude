import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, SystemStatus } from '../../../shared/protocol.js';
import { sessions } from '../agent/session.js';
import { config } from '../config.js';
import { AUTH_SECRET_KEYS, secrets, settings } from '../settings.js';
import { toolVersion } from '../util/exec.js';

let toolchainCache: { at: number; value: Record<string, string | null> } | null = null;

async function toolchains() {
  if (toolchainCache && Date.now() - toolchainCache.at < 5 * 60_000) return toolchainCache.value;
  const checks: [string, string, string?][] = [
    ['node', 'node'],
    ['npm', 'npm'],
    ['pnpm', 'pnpm'],
    ['bun', 'bun'],
    ['python', 'python3'],
    ['uv', 'uv'],
    ['go', 'go', 'version'],
    ['rust', 'rustc'],
    ['java', 'java', '-version'],
    ['docker', 'docker'],
    ['git', 'git'],
    ['gh', 'gh'],
    ['claude', 'claude'],
    ['cloudflared', 'cloudflared'],
    ['mise', 'mise'],
  ];
  const entries = await Promise.all(checks.map(async ([name, bin, arg]) => [name, await toolVersion(bin, arg)] as const));
  toolchainCache = { at: Date.now(), value: Object.fromEntries(entries) };
  return toolchainCache.value;
}

function claudeAuth(): SystemStatus['claudeAuth'] {
  const vals = { ...process.env, ...secrets.values(null) } as Record<string, string | undefined>;
  if (vals.ANTHROPIC_API_KEY) return { configured: true, source: 'api_key' };
  if (vals.CLAUDE_CODE_OAUTH_TOKEN) return { configured: true, source: 'oauth_token' };
  // `claude login` in the web terminal stores credentials under ~/.claude (Linux) or the keychain (macOS).
  const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
  const cfg = path.join(os.homedir(), '.claude.json');
  let loggedIn = fs.existsSync(credFile);
  if (!loggedIn && fs.existsSync(cfg)) {
    try {
      loggedIn = !!JSON.parse(fs.readFileSync(cfg, 'utf8')).oauthAccount;
    } catch {
      /* ignore */
    }
  }
  // On macOS the login lives in the Keychain, readable only by the user's own `claude` binary.
  if (process.platform === 'darwin' && !config.claudePath && !fs.existsSync(credFile)) loggedIn = false;
  return loggedIn ? { configured: true, source: 'cli_login' } : { configured: false, source: 'none' };
}

export function registerSystemRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  app.get('/api/status', async (): Promise<SystemStatus> => {
    let disk: SystemStatus['disk'] = null;
    try {
      const s = fs.statfsSync(config.workspacesDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* not supported */
    }
    return {
      version: config.version,
      claudeAuth: claudeAuth(),
      publicUrl: config.publicUrl,
      previewDomain: config.previewDomain,
      previewMode: config.previewDomain ? 'subdomain' : 'path',
      toolchains: await toolchains(),
      disk,
      activeSessions: sessions.activeCount(),
    };
  });

  app.get('/api/settings', async () => ({ settings: settings.get() }));
  app.put<{ Body: Partial<AppSettings> }>('/api/settings', async (req) => ({ settings: settings.update(req.body ?? {}) }));

  // Secrets: projectId omitted => global
  app.get<{ Querystring: { projectId?: string } }>('/api/secrets', async (req) => ({
    secrets: secrets.list(req.query.projectId ?? null),
    authKeys: AUTH_SECRET_KEYS,
  }));
  app.put<{ Body: { projectId?: string | null; key: string; value: string } }>('/api/secrets', async (req) => {
    secrets.set(req.body.projectId ?? null, req.body.key.trim(), String(req.body.value));
    return { ok: true };
  });
  app.delete<{ Querystring: { projectId?: string; key: string } }>('/api/secrets', async (req) => {
    secrets.delete(req.query.projectId ?? null, req.query.key);
    return { ok: true };
  });
}
