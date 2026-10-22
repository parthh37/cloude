import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command (no shell) and capture output. Never rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>) });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err.message) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** First line of `<bin> <versionArg>` or null when the tool isn't installed. */
export async function toolVersion(bin: string, arg = '--version'): Promise<string | null> {
  const r = await run(bin, [arg], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0] ?? null;
}
