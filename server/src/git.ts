import type { GitStatus } from '../../shared/protocol.js';
import { buildEnv } from './settings.js';
import { run } from './util/exec.js';
import { HttpError } from './util/paths.js';

async function git(cwd: string, args: string[], projectId: string | null = null, timeoutMs = 60_000) {
  return run('git', args, { cwd, env: buildEnv(projectId), timeoutMs });
}

async function gitOk(cwd: string, args: string[], projectId: string | null = null, timeoutMs?: number) {
  const r = await git(cwd, args, projectId, timeoutMs);
  if (r.code !== 0) throw new HttpError(400, (r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout;
}

export async function status(cwd: string): Promise<GitStatus> {
  const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (r.code !== 0) return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const out: GitStatus = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.startsWith('# branch.head ')) out.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      out.files.push({ path: f.slice(8).join(' '), index: f[1]![0]!, worktree: f[1]![1]! });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      out.files.push({ path: f.slice(9).join(' '), index: f[1]![0]!, worktree: f[1]![1]! });
      i++; // rename entries carry the original path as the next NUL field
    } else if (line.startsWith('u ')) {
      const f = line.split(' ');
      out.files.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U' });
    } else if (line.startsWith('? ')) {
      out.files.push({ path: line.slice(2), index: '?', worktree: '?' });
    }
  }
  return out;
}

export async function diff(cwd: string, file?: string, staged = false): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached');
  if (file) args.push('--', file);
  let out = (await git(cwd, args)).stdout;
  // Untracked files have no diff; show them as all-added.
  if (!out && file && !staged) {
    const r = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    out = r.stdout;
  }
  return out;
}

export async function log(cwd: string, limit = 50) {
  const r = await git(cwd, ['log', `-${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, short, author, at, subject] = l.split('\x1f');
      return { hash, short, author, date: Number(at) * 1000, subject };
    });
}

export async function branches(cwd: string) {
  const r = await git(cwd, ['branch', '-a', '--format=%(refname:short)%x1f%(HEAD)']);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, head] = l.split('\x1f');
      return { name: name!, current: head === '*' };
    });
}

export async function stage(cwd: string, paths: string[]) {
  await gitOk(cwd, ['add', '--', ...(paths.length ? paths : ['.'])]);
}

export async function unstage(cwd: string, paths: string[]) {
  await gitOk(cwd, ['reset', '-q', 'HEAD', '--', ...(paths.length ? paths : ['.'])]);
}

export async function discard(cwd: string, paths: string[]) {
  if (!paths.length) throw new HttpError(400, 'Specify files to discard');
  await git(cwd, ['checkout', '--', ...paths]);
  await git(cwd, ['clean', '-fd', '--', ...paths]);
}

export async function commit(cwd: string, message: string, all: boolean) {
  if (!message.trim()) throw new HttpError(400, 'Commit message is required');
  if (all) await gitOk(cwd, ['add', '-A']);
  // Use the configured identity when there is one; fall back so commits never fail on a fresh server.
  const hasIdentity = (await git(cwd, ['config', 'user.email'])).stdout.trim() !== '';
  const identity = hasIdentity ? [] : ['-c', 'user.name=Cloude', '-c', 'user.email=cloude@localhost'];
  return gitOk(cwd, [...identity, 'commit', '-m', message]);
}

export async function push(cwd: string, projectId: string) {
  const st = await status(cwd);
  const args = st.upstream ? ['push'] : ['push', '-u', 'origin', st.branch ?? 'HEAD'];
  const r = await git(cwd, args, projectId, 120_000);
  if (r.code !== 0) throw new HttpError(400, r.stderr.trim());
  return (r.stdout + r.stderr).trim();
}

export async function pull(cwd: string, projectId: string) {
  return gitOk(cwd, ['pull', '--ff-only'], projectId, 120_000);
}

export async function checkout(cwd: string, branch: string, create: boolean) {
  return gitOk(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch]);
}
