import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const dataDir = path.resolve(env('CLOUDE_DATA_DIR', path.join(os.homedir(), '.cloude'))!);
fs.mkdirSync(dataDir, { recursive: true });

const workspacesDir = path.resolve(env('CLOUDE_WORKSPACES_DIR', path.join(dataDir, 'workspaces'))!);
fs.mkdirSync(workspacesDir, { recursive: true });

/** Persist a random secret on first boot so cookies/encrypted secrets survive restarts. */
function loadSecret(): Buffer {
  const fromEnv = env('CLOUDE_SECRET');
  if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest();
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

const port = Number(env('PORT', '8787'));
const publicUrl = (env('CLOUDE_PUBLIC_URL', `http://localhost:${port}`) as string).replace(/\/$/, '');

export const config = {
  version: '0.1.0',
  host: env('HOST', '0.0.0.0')!,
  port,
  publicUrl,
  publicHost: new URL(publicUrl).host,
  secure: publicUrl.startsWith('https://'),
  /**
   * Wildcard domain for previews: "<label>.<previewDomain>". When unset, previews
   * fall back to path mode (/preview/<port>/) which works without DNS but breaks
   * apps that use absolute asset paths.
   */
  previewDomain: env('CLOUDE_PREVIEW_DOMAIN') ?? null,
  dataDir,
  workspacesDir,
  dbPath: path.join(dataDir, 'cloude.db'),
  secret: loadSecret(),
  adminUser: env('CLOUDE_ADMIN_USER', 'admin')!,
  adminPassword: env('CLOUDE_ADMIN_PASSWORD'),
  webDist: path.resolve(env('CLOUDE_WEB_DIST', path.resolve(import.meta.dirname, '../../web/dist'))!),
  /** Directory for the compiled web app when running from dist/ */
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
  /** Ports Cloude never exposes through the preview proxy. */
  reservedPorts: new Set<number>([port]),
  shell: env('SHELL', fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')!,
  /**
   * Claude Code executable for agent sessions. Defaults to the binary bundled
   * with the Agent SDK. On macOS, point this at your installed `claude` so it
   * can read the login stored in the Keychain.
   */
  claudePath: env('CLOUDE_CLAUDE_PATH'),
  trustProxy: env('CLOUDE_TRUST_PROXY', 'true') === 'true',
};

// Allow the web dist path to be found both from src (tsx) and dist (compiled) layouts.
if (!fs.existsSync(config.webDist)) {
  const alt = path.resolve(import.meta.dirname, '../../../../web/dist');
  if (fs.existsSync(alt)) config.webDist = alt;
}

/** Absolute path of an executable on PATH, or null. */
export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Browser-testing MCP server: the pre-installed binary (Docker image) or npx as a fallback. */
export const playwrightMcp = (() => {
  const args = ['--headless', '--isolated'];
  const bin = which('playwright-mcp');
  return bin ? { command: bin, args } : { command: 'npx', args: ['-y', '@playwright/mcp@latest', ...args] };
})();

export type Config = typeof config;

/**
 * Origin for a sibling host (preview/app subdomain), reusing the public URL's
 * scheme and port — so local setups like http://cloude.localhost:8787 work too.
 */
export function originFor(host: string): string {
  const u = new URL(config.publicUrl);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}
