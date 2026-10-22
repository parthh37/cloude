import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pty from '@lydell/node-pty';
import type { ClaudeLoginStart } from '../../shared/protocol.js';
import { config, which } from './config.js';
import { newId } from './crypto.js';
import { AUTH_SECRET_KEYS, buildEnv } from './settings.js';
import { HttpError } from './util/paths.js';

/**
 * "Sign in with Claude" without a terminal.
 *
 * Drives the official `claude setup-token` in a hidden PTY: the CLI prints an
 * OAuth link, the browser shows it, the user approves on claude.com and pastes
 * the code they're given, and we type that code into the CLI and capture the
 * long-lived token it prints. Only one sign-in runs at a time (single admin).
 */

// The link is printed twice: as an OSC 8 hyperlink target (ends at BEL) and as text.
const URL_RE = /https:\/\/[^\s\x07\x1b"']+\/oauth\/authorize\?[^\s\x07\x1b"']+/;
const TOKEN_RE = /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/;
const ERROR_RE = /OAuth error:?\s*([^\r\n\x1b]+)/;
const ATTEMPT_TTL_MS = 10 * 60_000;

interface Attempt {
  id: string;
  proc: pty.IPty;
  output: string;
  exited: boolean;
  expires: NodeJS.Timeout;
}

let current: Attempt | null = null;

/** Executable that can run `setup-token`: the configured one, `claude` on PATH, or the Agent SDK's bundled binary. */
function claudeExecutable(): string {
  if (config.claudePath) return config.claudePath;
  const onPath = which('claude');
  if (onPath) return onPath;
  const require = createRequire(import.meta.url);
  const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
  const fromSdk = createRequire(path.join(sdkDir, 'package.json'));
  for (const suffix of ['', '-musl']) {
    try {
      const pkg = fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`);
      return path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    } catch {
      /* try the next variant */
    }
  }
  throw new HttpError(500, 'Claude Code is not installed on the server. Paste a token or an API key instead.');
}

/** Visible text of a TUI transcript, for error messages. */
function plain(s: string) {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?>]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b./g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function until<T>(check: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function cancelClaudeLogin(id?: string) {
  if (!current || (id && current.id !== id)) return;
  clearTimeout(current.expires);
  if (!current.exited) current.proc.kill();
  current = null;
}

export async function startClaudeLogin(): Promise<ClaudeLoginStart> {
  cancelClaudeLogin();
  const env = buildEnv(null, { BROWSER: 'none', TERM: 'xterm-256color' });
  for (const k of AUTH_SECRET_KEYS) delete env[k]; // a configured key would change what the CLI does
  // Wide enough that the link and token are never wrapped across lines.
  const proc = pty.spawn(claudeExecutable(), ['setup-token'], { name: 'xterm-256color', cols: 500, rows: 50, cwd: os.homedir(), env });
  const attempt: Attempt = { id: newId(), proc, output: '', exited: false, expires: setTimeout(() => cancelClaudeLogin(attempt.id), ATTEMPT_TTL_MS) };
  attempt.expires.unref();
  proc.onData((d) => {
    attempt.output = (attempt.output + d).slice(-64 * 1024);
  });
  proc.onExit(() => {
    attempt.exited = true;
  });
  current = attempt;

  const url = await until(() => URL_RE.exec(attempt.output)?.[0] ?? (attempt.exited ? 'exited' : null), 30_000);
  if (!url || url === 'exited') {
    const tail = plain(attempt.output).slice(-300);
    cancelClaudeLogin(attempt.id);
    throw new HttpError(502, `Claude Code didn't print a sign-in link${tail ? `: ${tail}` : ''}`);
  }
  return { id: attempt.id, url };
}

/** Type the code from claude.com into the waiting CLI and return the token it prints. */
export async function finishClaudeLogin(id: string, code: string): Promise<string> {
  const attempt = current;
  if (!attempt || attempt.id !== id || attempt.exited) throw new HttpError(410, 'This sign-in expired. Start again.');
  const trimmed = code.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new HttpError(400, 'Paste the whole code from the Claude page');

  attempt.output = ''; // only look at what the CLI says from here on
  attempt.proc.write(trimmed);
  // A separate keystroke: Ink treats "code\r" in one chunk as text, not as Enter.
  await new Promise((r) => setTimeout(r, 250));
  attempt.proc.write('\r');

  const result = await until<{ token: string } | { error: string }>(() => {
    const token = TOKEN_RE.exec(attempt.output)?.[0];
    if (token) return { token };
    const err = ERROR_RE.exec(plain(attempt.output))?.[1];
    if (err) return { error: err.trim() };
    if (attempt.exited) return { error: plain(attempt.output).slice(-200) || 'Claude Code exited' };
    return null;
  }, 60_000);
  cancelClaudeLogin(attempt.id);

  if (!result) throw new HttpError(504, 'Timed out waiting for Claude Code. Start again.');
  if ('error' in result) throw new HttpError(400, `Sign-in failed: ${result.error}. Start again and paste the full code.`);
  return result.token;
}
