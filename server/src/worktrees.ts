import fs from 'node:fs';
import path from 'node:path';
import type { Project, Worktree, WorktreeStatus } from '../../shared/protocol.js';
import { db, now } from './db.js';
import { hub } from './hub.js';
import { projects } from './projects.js';
import { ensureSchema } from './schema.js';
import { routes } from './services/routes-store.js';
import { services } from './services/service-manager.js';
import { terminals } from './terminal/terminals.js';
import { buildEnv } from './settings.js';
import { run } from './util/exec.js';
import { HttpError, safeJoin, slugify } from './util/paths.js';

/**
 * Git worktrees for conflict-free parallel work.
 *
 * Each isolated session (or board card run) gets `<project>/.cloude/worktrees/<id>`
 * on its own branch `cloude/<id>`. Living *inside* the project means every
 * existing project-relative API (services' cwd, terminals, the preview proxy's
 * static dirs) works on a worktree without special cases, and `.cloude/` is
 * excluded locally via `.git/info/exclude` so it never shows up as untracked.
 */

ensureSchema(
  'worktrees-v1',
  `
  CREATE TABLE worktrees (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE INDEX worktrees_owner ON worktrees(owner_type, owner_id);
  `,
);

export const WORKTREES_DIR = '.cloude/worktrees';

interface WorktreeRow {
  id: string;
  project_id: string;
  path: string;
  branch: string;
  base_branch: string;
  owner_type: Worktree['ownerType'];
  owner_id: string | null;
  created_at: number;
}

function toWorktree(r: WorktreeRow): Worktree {
  const project = projects.get(r.project_id);
  return {
    id: r.id,
    projectId: r.project_id,
    path: r.path,
    relPath: project ? path.relative(project.path, r.path) : r.path,
    branch: r.branch,
    baseBranch: r.base_branch,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    createdAt: r.created_at,
  };
}

async function git(cwd: string, args: string[], projectId: string | null = null, timeoutMs = 60_000) {
  return run('git', args, { cwd, env: buildEnv(projectId), timeoutMs });
}

async function gitOk(cwd: string, args: string[], projectId: string | null = null, timeoutMs?: number) {
  const r = await git(cwd, args, projectId, timeoutMs);
  if (r.code !== 0) throw new HttpError(400, (r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout.trim();
}

/** Commit identity that never fails on a fresh server (the repo's own config wins when set). */
async function identityArgs(cwd: string): Promise<string[]> {
  const hasIdentity = (await git(cwd, ['config', 'user.email'])).stdout.trim() !== '';
  return hasIdentity ? [] : ['-c', 'user.name=Cloude', '-c', 'user.email=cloude@localhost'];
}

/** `git status --porcelain` lines. Throws when git can't read the checkout — never report "clean" on error. */
async function porcelain(cwd: string, untracked = true): Promise<string[]> {
  const r = await git(cwd, ['status', '--porcelain', untracked ? '--untracked-files=all' : '--untracked-files=no']);
  if (r.code !== 0) throw new HttpError(409, `git status failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');

const NO_COMMITS =
  'Worktrees branch from a commit, and this project has files that are not committed yet — an isolated session would start from an empty checkout. ' +
  'Commit your files first (Git panel), or turn off "Isolated worktree" to work in the main checkout.';

/** Make sure the project is a git repo with at least one commit, so `worktree add` has something to branch from. */
async function ensureRepo(project: Project) {
  // Only a project with no files of its own may be initialised/committed automatically;
  // anything else would hand the agent an empty worktree while the real files sit untracked.
  const hasFiles = fs.readdirSync(project.path).some((f) => f !== '.git' && f !== '.cloude');
  if ((await git(project.path, ['rev-parse', '--is-inside-work-tree'])).code !== 0) {
    if (hasFiles) throw new HttpError(409, NO_COMMITS);
    await gitOk(project.path, ['init', '-b', 'main']);
  }
  const top = (await git(project.path, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (top && fs.realpathSync(top) !== fs.realpathSync(project.path)) {
    throw new HttpError(409, `This project is a subfolder of the repository at ${top}; isolated worktrees need the project to be the repository root. Use a shared session instead.`);
  }
  if ((await git(project.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
    if (hasFiles) throw new HttpError(409, NO_COMMITS);
    // Unborn branch in an empty project: an empty root commit changes no files and has no history to disturb.
    await gitOk(project.path, [...(await identityArgs(project.path)), 'commit', '--allow-empty', '-m', 'Initial commit']);
  }
}

async function ensureExcluded(project: Project) {
  const common = await gitOk(project.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const file = path.join(common, 'info', 'exclude');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === '.cloude/' || l.trim() === '/.cloude/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Cloude worktrees, outputs and scratch files\n/.cloude/\n`);
}

/** Untracked env files (`.env`, `.env.local`, …) don't come along with `git worktree add`; dev servers usually need them. */
function copyEnvFiles(from: string, to: string) {
  for (const name of fs.readdirSync(from)) {
    if (!/^\.env(\..+)?$/.test(name) || /\.(example|sample|template)$/.test(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.existsSync(dest) || !fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, dest);
  }
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function branchExists(cwd: string, branch: string) {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** branch -> path of the worktree that has it checked out (including the main checkout). */
async function checkedOutBranches(cwd: string): Promise<Map<string, string>> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  const out = new Map<string, string>();
  let wtPath: string | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) wtPath = line.slice(9);
    else if (line.startsWith('branch refs/heads/') && wtPath) out.set(line.slice(18), wtPath);
  }
  return out;
}

function broadcast(projectId: string) {
  hub.broadcast({ t: 'worktrees', projectId, worktrees: worktrees.list(projectId) });
}

export const worktrees = {
  list(projectId: string): Worktree[] {
    const rows = db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as WorktreeRow[];
    return rows.map(toWorktree);
  },

  get(projectId: string, id: string): Worktree | null {
    const r = db.prepare('SELECT * FROM worktrees WHERE project_id = ? AND id = ?').get(projectId, id) as unknown as WorktreeRow | undefined;
    return r ? toWorktree(r) : null;
  },

  require(projectId: string, id: string): Worktree {
    const w = this.get(projectId, id);
    if (!w) throw new HttpError(404, 'Worktree not found');
    return w;
  },

  forOwner(ownerType: Worktree['ownerType'], ownerId: string): Worktree | null {
    const r = db.prepare('SELECT * FROM worktrees WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1').get(ownerType, ownerId) as unknown as
      | WorktreeRow
      | undefined;
    return r ? toWorktree(r) : null;
  },

  setOwner(projectId: string, id: string, ownerType: Worktree['ownerType'], ownerId: string | null) {
    db.prepare('UPDATE worktrees SET owner_type = ?, owner_id = ? WHERE project_id = ? AND id = ?').run(ownerType, ownerId, projectId, id);
    broadcast(projectId);
  },

  async create(
    projectId: string,
    opts: { name?: string; base?: string; ownerType: Worktree['ownerType']; ownerId?: string | null },
  ): Promise<Worktree> {
    const project = projects.require(projectId);
    await ensureRepo(project);
    await ensureExcluded(project);

    const base = opts.base?.trim() || (await currentBranch(project.path));
    if (!base) throw new HttpError(400, 'The main checkout is in detached HEAD. Check out a branch first (Git panel), then start the session again.');
    if (!(await branchExists(project.path, base))) throw new HttpError(400, `Base branch "${base}" does not exist`);

    const stem = slugify(opts.name?.trim() || `task-${Math.random().toString(36).slice(2, 7)}`).slice(0, 40);
    let id = stem;
    for (let i = 2; this.get(projectId, id) || fs.existsSync(path.join(project.path, WORKTREES_DIR, id)) || (await branchExists(project.path, `cloude/${id}`)); i++) {
      id = `${stem}-${i}`;
    }
    const branch = `cloude/${id}`;
    const dir = path.join(project.path, WORKTREES_DIR, id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await gitOk(project.path, ['worktree', 'add', '-b', branch, dir, base], projectId, 5 * 60_000);
    try {
      copyEnvFiles(project.path, dir);
    } catch {
      /* best effort */
    }

    db.prepare(
      'INSERT INTO worktrees (id, project_id, path, branch, base_branch, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, projectId, dir, branch, base, opts.ownerType, opts.ownerId ?? null, now());
    broadcast(projectId);
    return this.require(projectId, id);
  },

  async status(projectId: string, id: string): Promise<WorktreeStatus> {
    const wt = this.require(projectId, id);
    const project = projects.require(projectId);
    const exists = fs.existsSync(wt.path);
    const out: WorktreeStatus = { worktree: wt, exists, ahead: 0, behind: 0, dirty: 0, merged: false, conflicts: [], files: [] };
    const counts = await git(project.path, ['rev-list', '--left-right', '--count', `${wt.baseBranch}...${wt.branch}`]);
    if (counts.code === 0) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      out.behind = behind ?? 0;
      out.ahead = ahead ?? 0;
    }
    out.merged = (await git(project.path, ['merge-base', '--is-ancestor', wt.branch, wt.baseBranch])).code === 0;
    const numstat = await git(project.path, ['diff', '--numstat', `${wt.baseBranch}...${wt.branch}`]);
    out.files = numstat.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r, ...p] = l.split('\t');
        return { path: p.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 };
      });
    if (exists) {
      const lines = await porcelain(wt.path);
      out.dirty = lines.length;
      out.conflicts = lines.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l)).map((l) => l.slice(3));
    }
    return out;
  },

  /** Commit everything in the worktree (used before removal so no work is ever lost). */
  async snapshot(projectId: string, id: string, message: string): Promise<boolean> {
    const wt = this.require(projectId, id);
    if (!fs.existsSync(wt.path) || (await porcelain(wt.path)).length === 0) return false;
    await gitOk(wt.path, ['add', '-A']);
    await gitOk(wt.path, [...(await identityArgs(wt.path)), 'commit', '--no-verify', '-m', message]);
    return true;
  },

  /**
   * Bring the base branch into the worktree (`git merge <base>`). Conflicts are
   * left in place for Claude (or the user) to resolve inside the worktree, which
   * is exactly where they can't disturb anyone else.
   */
  async sync(projectId: string, id: string): Promise<WorktreeStatus> {
    const wt = this.require(projectId, id);
    if ((await porcelain(wt.path, false)).length) throw new HttpError(409, 'Commit or discard the changes in this worktree before syncing.');
    // --no-verify: repo hooks (husky, commitlint) often can't run in a fresh worktree without node_modules.
    const r = await git(wt.path, [...(await identityArgs(wt.path)), 'merge', '--no-verify', '--no-edit', wt.baseBranch], projectId, 120_000);
    const st = await this.status(projectId, id);
    if (r.code !== 0 && st.conflicts.length === 0) {
      await git(wt.path, ['merge', '--abort']); // never leave a half-done merge behind
      throw new HttpError(400, (r.stderr || r.stdout).trim() || 'git merge failed');
    }
    return st;
  },

  /**
   * Land the worktree branch on its base. Fast-forwards when possible; otherwise
   * makes a merge commit (or a squash commit) in whichever checkout has the base
   * branch, and refuses rather than leaving a half-merged main checkout.
   */
  async merge(
    projectId: string,
    id: string,
    opts: { squash?: boolean; message?: string; commitMessage?: string } = {},
  ): Promise<{ output: string; status: WorktreeStatus }> {
    const wt = this.require(projectId, id);
    const project = projects.require(projectId);
    if (opts.commitMessage?.trim()) await this.snapshot(projectId, id, opts.commitMessage.trim());
    // Untracked files count: they're usually new source files the agent never committed, and
    // merging without them would report "up to date" while silently leaving the work behind.
    if (fs.existsSync(wt.path) && (await porcelain(wt.path)).length) {
      throw new HttpError(409, 'This worktree has uncommitted changes. Commit them (or ask Claude to) before merging.');
    }
    const message = opts.message?.trim() || `Merge ${wt.branch}`;
    const holders = await checkedOutBranches(project.path);
    const basePath = holders.get(wt.baseBranch);
    let output: string;

    if (basePath) {
      if ((await porcelain(basePath, false)).length) {
        throw new HttpError(409, `The checkout of ${wt.baseBranch} (${basePath}) has uncommitted changes. Commit or stash them first.`);
      }
      const ident = await identityArgs(basePath);
      if (opts.squash) {
        const r = await git(basePath, ['merge', '--squash', wt.branch]);
        if (r.code !== 0) {
          await git(basePath, ['reset', '--merge']);
          throw new HttpError(409, `Squash failed. Use "Sync" to merge ${wt.baseBranch} into the worktree first.\n${tail(r)}`);
        }
        output = await gitOk(basePath, [...ident, 'commit', '--no-verify', '-m', message]);
      } else {
        const ff = await git(basePath, ['merge', '--ff-only', wt.branch]);
        if (ff.code === 0) output = ff.stdout.trim();
        else {
          const r = await git(basePath, [...ident, 'merge', '--no-verify', '--no-edit', '-m', message, wt.branch]);
          if (r.code !== 0) {
            const conflicted = (await porcelain(basePath, false)).some((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l));
            await git(basePath, ['merge', '--abort']);
            throw new HttpError(
              409,
              conflicted ? `Merging would conflict. Use "Sync" to merge ${wt.baseBranch} into the worktree and resolve there first.` : `git merge failed:\n${tail(r)}`,
            );
          }
          output = r.stdout.trim();
        }
      }
    } else {
      // Base isn't checked out anywhere: move the ref directly, but only when that's a clean fast-forward of a synced branch.
      const baseSha = await gitOk(project.path, ['rev-parse', `refs/heads/${wt.baseBranch}`]);
      if ((await git(project.path, ['merge-base', '--is-ancestor', baseSha, wt.branch])).code !== 0) {
        throw new HttpError(409, `${wt.baseBranch} has moved on. Use "Sync" first, then merge.`);
      }
      let target = await gitOk(project.path, ['rev-parse', wt.branch]);
      if (opts.squash && target !== baseSha) {
        const tree = await gitOk(project.path, ['rev-parse', `${wt.branch}^{tree}`]);
        target = await gitOk(project.path, [...(await identityArgs(project.path)), 'commit-tree', tree, '-p', baseSha, '-m', message]);
      }
      await gitOk(project.path, ['update-ref', `refs/heads/${wt.baseBranch}`, target, baseSha]);
      output = `${wt.baseBranch} → ${target.slice(0, 10)}`;
    }
    broadcast(projectId);
    return { output, status: await this.status(projectId, id) };
  },

  /**
   * After the branch landed, move it to the new base so the worktree can keep
   * being used (the owning session's transcript is tied to this directory).
   * Safe because merge() requires a clean worktree and everything is now in base.
   */
  async resetToBase(projectId: string, id: string) {
    const wt = this.require(projectId, id);
    if ((await git(wt.path, ['merge', '--ff-only', wt.baseBranch])).code === 0) return;
    if ((await porcelain(wt.path)).length) throw new HttpError(409, 'The worktree changed while merging; not resetting it.');
    await gitOk(wt.path, ['reset', '--hard', wt.baseBranch]);
  },

  async push(projectId: string, id: string): Promise<string> {
    const wt = this.require(projectId, id);
    const r = await git(wt.path, ['push', '-u', 'origin', wt.branch], projectId, 120_000);
    if (r.code !== 0) throw new HttpError(400, r.stderr.trim() || 'git push failed');
    return (r.stdout + r.stderr).trim();
  },

  /** Push the branch and open a pull request with the GitHub CLI. */
  async openPullRequest(projectId: string, id: string, opts: { title?: string; body?: string } = {}): Promise<string> {
    const wt = this.require(projectId, id);
    await this.push(projectId, id);
    const args = ['pr', 'create', '--base', wt.baseBranch, '--head', wt.branch];
    if (opts.title?.trim()) args.push('--title', opts.title.trim(), '--body', opts.body?.trim() || `Opened from Cloude (${wt.branch}).`);
    else args.push('--fill');
    const r = await run('gh', args, { cwd: wt.path, env: buildEnv(projectId), timeoutMs: 60_000 });
    if (r.code !== 0) throw new HttpError(400, (r.stderr || r.stdout).trim() || 'gh pr create failed (is GH_TOKEN set?)');
    return r.stdout.trim().split('\n').pop() ?? '';
  },

  /**
   * Remove the worktree directory. Uncommitted work is snapshotted onto the branch
   * first; the branch itself is kept unless it's already merged (or `deleteBranch`).
   */
  async remove(projectId: string, id: string, opts: { deleteBranch?: boolean } = {}) {
    const wt = this.require(projectId, id);
    const project = projects.require(projectId);
    const inside = (p: string) => p === wt.path || p.startsWith(wt.path + path.sep);

    // Deployments and published folders served from here would break silently.
    const deploys = services.list(projectId).filter((s) => s.kind === 'deploy' && inside(safeJoin(project.path, s.cwd || '.')));
    const published = routes.list().filter((r) => r.staticDir && inside(r.staticDir));
    if (deploys.length || published.length) {
      throw new HttpError(
        409,
        `Still serving from this worktree: ${[...deploys.map((d) => `deployment "${d.name}"`), ...published.map((r) => `published "${r.label}"`)].join(', ')}. ` +
          'Redeploy from the main checkout (or unpublish) first.',
      );
    }

    if (fs.existsSync(wt.path)) {
      // Snapshot errors abort the removal: better a stuck worktree than lost work.
      await this.snapshot(projectId, id, 'WIP: snapshot before removing worktree');
      if ((await porcelain(wt.path)).length) throw new HttpError(409, 'The worktree still has uncommitted changes after the snapshot; not removing it.');
      for (const s of services.list(projectId)) if (s.kind === 'dev' && inside(safeJoin(project.path, s.cwd || '.'))) await services.remove(s.id);
      for (const t of terminals.list(projectId)) if (inside(t.cwd)) terminals.kill(t.id);
      const r = await git(project.path, ['worktree', 'remove', '--force', wt.path]);
      if (r.code !== 0) throw new HttpError(409, `git worktree remove failed: ${tail(r)}`);
    }
    await git(project.path, ['worktree', 'prune']);
    const merged = (await git(project.path, ['merge-base', '--is-ancestor', wt.branch, wt.baseBranch])).code === 0;
    // `-d` would compare against the main checkout's HEAD, not the base, so use -D once merged-ness is known.
    if (opts.deleteBranch || merged) await git(project.path, ['branch', '-D', wt.branch]);
    db.prepare('DELETE FROM worktrees WHERE project_id = ? AND id = ?').run(projectId, id);
    broadcast(projectId);
  },
};

// ---- scopes: a project root or one of its worktrees --------------------------------

export interface Scope {
  project: Project;
  root: string;
  worktree: Worktree | null;
}

/** Resolve `<projectId>` or `<projectId>~<worktreeId>` to the directory it refers to. */
export function resolveScope(scopeId: string): Scope {
  const [projectId, wtId] = scopeId.split('~');
  const project = projects.require(projectId!);
  if (!wtId) return { project, root: project.path, worktree: null };
  const worktree = worktrees.require(project.id, wtId);
  if (!fs.existsSync(worktree.path)) throw new HttpError(410, `Worktree ${wtId} was removed`);
  safeJoin(project.path, worktree.relPath); // must stay inside the project
  return { project, root: worktree.path, worktree };
}

export const scopeIdFor = (projectId: string, worktree: Worktree | null) => (worktree ? `${projectId}~${worktree.id}` : projectId);
