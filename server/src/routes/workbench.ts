import type { FastifyInstance } from 'fastify';
import type { BoardCard, BoardColumn, Isolation, Memory, PermissionMode, WorkbenchSettings, Worktree } from '../../../shared/protocol.js';
import { agentClis } from '../agents/clis.js';
import { compressionStats } from '../agent/compression.js';
import { sessions } from '../agent/session.js';
import { board } from '../board.js';
import { desktop, workbenchSettings } from '../desktop.js';
import { MCP_CATALOG } from '../mcp-catalog.js';
import { memory } from '../memory.js';
import { projects } from '../projects.js';
import { extSettings } from '../schema.js';
import { run } from '../util/exec.js';
import { HttpError } from '../util/paths.js';
import { buildEnv } from '../settings.js';
import { worktrees } from '../worktrees.js';

type WT = { Params: { id: string; wt: string } };

function ownerSession(wt: Worktree) {
  if (wt.ownerType !== 'session' || !wt.ownerId) return null;
  try {
    return sessions.get(wt.ownerId);
  } catch {
    return null; // session was deleted
  }
}

/**
 * Landing or removing a worktree while its agent is mid-turn would race the agent's
 * own edits, so refuse; an idle-but-alive Claude process is stopped (it resumes later).
 */
function quiesceOwner(wt: Worktree) {
  const s = ownerSession(wt);
  if (!s) return;
  if (s.row.status === 'running' || s.row.status === 'starting' || s.row.status === 'awaiting_input') {
    throw new HttpError(409, `"${s.row.title}" is still working in this worktree. Wait for it to finish or stop it first.`);
  }
  s.stop();
}

export function registerWorkbenchRoutes(app: FastifyInstance) {
  // ---- worktrees -------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/worktrees', async (req) => ({ worktrees: worktrees.list(projects.require(req.params.id).id) }));

  app.post<{ Params: { id: string }; Body: { name?: string; base?: string } }>('/api/projects/:id/worktrees', async (req) => ({
    worktree: await worktrees.create(req.params.id, { name: req.body?.name, base: req.body?.base, ownerType: 'manual' }),
  }));

  app.get<WT>('/api/projects/:id/worktrees/:wt', async (req) => worktrees.status(req.params.id, req.params.wt));

  /** Review diff: everything the branch changes vs its base, including uncommitted edits in the worktree. */
  app.get<WT & { Querystring: { path?: string } }>('/api/projects/:id/worktrees/:wt/diff', async (req) => {
    const wt = worktrees.require(req.params.id, req.params.wt);
    const base = await run('git', ['merge-base', wt.baseBranch, 'HEAD'], { cwd: wt.path });
    if (base.code !== 0) throw new HttpError(400, base.stderr.trim() || 'Could not find the merge base');
    const args = ['diff', '--no-color', '--no-ext-diff', base.stdout.trim()];
    if (req.query.path) args.push('--', req.query.path);
    const r = await run('git', args, { cwd: wt.path, timeoutMs: 30_000 });
    // New files an agent hasn't committed yet are invisible to `git diff`; show them as additions.
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard', ...(req.query.path ? ['--', req.query.path] : [])], { cwd: wt.path });
    let extra = '';
    for (const file of untracked.stdout.split('\n').filter(Boolean).slice(0, 50)) {
      const d = await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { cwd: wt.path, timeoutMs: 10_000 });
      extra += d.stdout;
      if (extra.length > 400_000) break;
    }
    return { diff: r.stdout + extra };
  });

  app.post<WT>('/api/projects/:id/worktrees/:wt/sync', async (req) => worktrees.sync(req.params.id, req.params.wt));

  app.post<WT & { Body: { squash?: boolean; message?: string; commitMessage?: string; remove?: boolean } }>('/api/projects/:id/worktrees/:wt/merge', async (req) => {
    const { id, wt } = req.params;
    const before = worktrees.require(id, wt);
    quiesceOwner(before);
    const result = await worktrees.merge(id, wt, { squash: req.body?.squash, message: req.body?.message, commitMessage: req.body?.commitMessage });
    board.markMerged(id, wt);
    if (ownerSession(before)) {
      // Claude's transcript is tied to this directory: keep it, on a branch that now equals the base.
      await worktrees.resetToBase(id, wt);
      return { ...result, kept: true, status: await worktrees.status(id, wt) };
    }
    if (req.body?.remove) await worktrees.remove(id, wt, { deleteBranch: true }); // its content just landed (a squash leaves no ancestry to detect that)
    return { ...result, kept: !req.body?.remove };
  });

  app.post<WT>('/api/projects/:id/worktrees/:wt/push', async (req) => ({ output: await worktrees.push(req.params.id, req.params.wt) }));

  app.post<WT & { Body: { title?: string; body?: string } }>('/api/projects/:id/worktrees/:wt/pr', async (req) => ({
    url: await worktrees.openPullRequest(req.params.id, req.params.wt, req.body ?? {}),
  }));

  app.delete<WT & { Querystring: { deleteBranch?: string } }>('/api/projects/:id/worktrees/:wt', async (req) => {
    const { id, wt } = req.params;
    const before = worktrees.require(id, wt);
    quiesceOwner(before);
    await worktrees.remove(id, wt, { deleteBranch: req.query.deleteBranch === 'true' });
    ownerSession(before)?.refreshWorktree(); // its next message starts a fresh conversation in the main checkout
    return { ok: true };
  });

  // ---- board -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/projects/:id/board', async (req) => ({ cards: board.list(projects.require(req.params.id).id) }));

  app.post<{ Params: { id: string }; Body: Partial<BoardCard> & { title: string } }>('/api/projects/:id/board', async (req) => ({
    card: board.create(req.params.id, req.body ?? ({} as never)),
  }));

  app.patch<{ Params: { cid: string }; Body: Partial<BoardCard> }>('/api/board/:cid', async (req) => {
    const { title, description, priority, labels, agent, isolation, column } = req.body ?? {};
    return { card: board.update(req.params.cid, { title, description, priority, labels, agent, isolation, column }) };
  });

  app.post<{ Params: { cid: string }; Body: { column: BoardColumn; index: number } }>('/api/board/:cid/move', async (req) => ({
    card: board.move(req.params.cid, req.body.column, Number(req.body.index) || 0),
  }));

  app.post<{ Params: { cid: string }; Body: { model?: string; permissionMode?: PermissionMode } }>('/api/board/:cid/start', async (req) => ({
    card: await board.start(req.params.cid, req.body ?? {}),
  }));

  app.post<{ Params: { cid: string } }>('/api/board/:cid/stop', async (req) => ({ card: await board.stop(req.params.cid) }));

  app.delete<{ Params: { cid: string } }>('/api/board/:cid', async (req) => {
    board.remove(req.params.cid);
    return { ok: true };
  });

  // ---- agent CLIs --------------------------------------------------------------------
  app.get<{ Querystring: { fresh?: string } }>('/api/clis', async (req) => ({ clis: await agentClis.list(req.query.fresh === 'true') }));

  app.put<{ Body: { id?: string; name: string; command: string; headless?: string; install?: string; bin?: string; envKeys?: string[]; description?: string; docsUrl?: string } }>(
    '/api/clis',
    async (req) => {
      const id = agentClis.save({ ...req.body, headless: req.body.headless || null, install: req.body.install || null, docsUrl: req.body.docsUrl || null });
      return { clis: await agentClis.list(true), id };
    },
  );

  app.delete<{ Params: { cli: string } }>('/api/clis/:cli', async (req) => {
    agentClis.remove(req.params.cli);
    return { clis: await agentClis.list(true) };
  });

  app.post<{ Params: { cli: string } }>('/api/clis/:cli/install', async (req) => {
    const result = await agentClis.install(req.params.cli);
    return { ...result, clis: await agentClis.list(true) };
  });

  // ---- memory --------------------------------------------------------------------------
  app.get<{ Querystring: { projectId?: string; q?: string } }>('/api/memory', async (req) => ({
    memories: req.query.q ? memory.search(req.query.projectId ?? null, req.query.q, 50) : memory.list(req.query.projectId ?? null),
  }));

  app.post<{ Body: Pick<Memory, 'name' | 'description' | 'content' | 'type'> & { projectId?: string | null } }>('/api/memory', async (req) => ({
    memory: memory.save({ ...req.body, projectId: req.body.projectId ?? null }),
  }));

  app.patch<{ Params: { mid: string }; Body: Partial<Pick<Memory, 'name' | 'description' | 'content' | 'type'>> }>('/api/memory/:mid', async (req) => ({
    memory: memory.update(req.params.mid, req.body ?? {}),
  }));

  app.delete<{ Params: { mid: string } }>('/api/memory/:mid', async (req) => {
    memory.remove(req.params.mid);
    return { ok: true };
  });

  // ---- workbench settings & compression -------------------------------------------------
  app.get('/api/workbench', async () => ({ settings: workbenchSettings(), compression: compressionStats() }));

  app.put<{ Body: Partial<WorkbenchSettings> }>('/api/workbench', async (req) => {
    const cur = workbenchSettings();
    const b = req.body ?? {};
    const next: WorkbenchSettings = {
      compression: b.compression && ['off', 'balanced', 'aggressive'].includes(b.compression) ? b.compression : cur.compression,
      defaultIsolation: (b.defaultIsolation === 'shared' || b.defaultIsolation === 'worktree' ? b.defaultIsolation : cur.defaultIsolation) as Isolation,
      injectMemory: typeof b.injectMemory === 'boolean' ? b.injectMemory : cur.injectMemory,
      desktop: {
        width: clampInt(b.desktop?.width, 800, 3840, cur.desktop.width),
        height: clampInt(b.desktop?.height, 600, 2160, cur.desktop.height),
        autoStart: typeof b.desktop?.autoStart === 'boolean' ? b.desktop.autoStart : cur.desktop.autoStart,
      },
    };
    extSettings.set('workbench', next);
    return { settings: next };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/compression', async (req) => compressionStats(req.params.id));

  // ---- MCP catalog -----------------------------------------------------------------------
  app.get('/api/mcp/catalog', async () => ({ catalog: MCP_CATALOG }));

  // ---- virtual desktop ---------------------------------------------------------------------
  // Responses carry the VNC password; they're same-origin only (no CORS), so preview pages can't read them.
  app.get('/api/desktop', async () => ({ ...desktop.status(), ...desktop.credentials() }));
  app.post('/api/desktop/start', async () => ({ ...(await desktop.start()), ...desktop.credentials() }));
  app.post('/api/desktop/stop', async () => desktop.stop());

  // ---- toolchain doctor: what a project's stack needs vs what's installed ------------------
  app.get('/api/toolchains/dotnet', async () => {
    const r = await run('dotnet', ['--list-sdks'], { env: buildEnv(null), timeoutMs: 10_000 });
    return { sdks: r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [] };
  });
}

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== undefined ? Math.max(min, Math.min(max, n)) : fallback;
}
