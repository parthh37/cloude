import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import mime from 'mime-types';
import * as files from '../files.js';
import * as git from '../git.js';
import { terminals } from '../terminal/terminals.js';
import { safeJoin } from '../util/paths.js';
import { resolveScope } from '../worktrees.js';

type P = { Params: { id: string } };

export function registerWorkspaceRoutes(app: FastifyInstance) {
  // `:id` is a scope: a project id, or `<projectId>~<worktreeId>` for one of its worktrees.
  const root = (id: string) => resolveScope(id).root;
  const pid = (id: string) => resolveScope(id).project.id;

  // ---- files ----
  app.get<P & { Querystring: { path?: string; hidden?: string } }>('/api/projects/:id/files', async (req) => ({
    entries: await files.listDir(root(req.params.id), req.query.path ?? '', req.query.hidden === 'true'),
  }));

  app.get<P & { Querystring: { q: string } }>('/api/projects/:id/files/search', async (req) => ({
    paths: await files.searchFiles(root(req.params.id), String(req.query.q ?? '')),
  }));

  app.get<P & { Querystring: { path: string } }>('/api/projects/:id/file', async (req) => files.readFile(root(req.params.id), req.query.path));

  app.put<P & { Body: { path: string; content: string; expectedMtime?: number } }>(
    '/api/projects/:id/file',
    { bodyLimit: 20 * 1024 * 1024 },
    async (req) => files.writeFile(root(req.params.id), req.body.path, req.body.content, req.body.expectedMtime),
  );

  app.post<P & { Body: { path: string } }>('/api/projects/:id/files/mkdir', async (req) => {
    await files.makeDir(root(req.params.id), req.body.path);
    return { ok: true };
  });

  app.post<P & { Body: { from: string; to: string } }>('/api/projects/:id/files/rename', async (req) => {
    await files.renamePath(root(req.params.id), req.body.from, req.body.to);
    return { ok: true };
  });

  app.delete<P & { Querystring: { path: string } }>('/api/projects/:id/file', async (req) => {
    await files.deletePath(root(req.params.id), req.query.path);
    return { ok: true };
  });

  app.get<P & { Querystring: { path: string } }>('/api/projects/:id/raw', async (req, reply) => {
    const file = safeJoin(root(req.params.id), req.query.path);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return reply.code(404).send({ error: 'Not found' });
    reply.header('content-type', mime.lookup(file) || 'application/octet-stream');
    reply.header('content-disposition', `inline; filename="${path.basename(file).replace(/"/g, '')}"`);
    // Never let uploaded HTML/SVG run on the Cloude origin.
    reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(fs.createReadStream(file));
  });

  app.post<P & { Querystring: { dir?: string } }>('/api/projects/:id/upload', async (req) => {
    const saved: string[] = [];
    for await (const part of req.files()) saved.push(await files.saveUpload(root(req.params.id), req.query.dir ?? '', part.filename, part.file));
    return { saved };
  });

  // ---- git ----
  app.get<P>('/api/projects/:id/git/status', async (req) => git.status(root(req.params.id)));
  app.get<P & { Querystring: { path?: string; staged?: string } }>('/api/projects/:id/git/diff', async (req) => ({
    diff: await git.diff(root(req.params.id), req.query.path, req.query.staged === 'true'),
  }));
  app.get<P>('/api/projects/:id/git/log', async (req) => ({ commits: await git.log(root(req.params.id)) }));
  app.get<P>('/api/projects/:id/git/branches', async (req) => ({ branches: await git.branches(root(req.params.id)) }));
  app.post<P & { Body: { paths?: string[] } }>('/api/projects/:id/git/stage', async (req) => {
    await git.stage(root(req.params.id), req.body?.paths ?? []);
    return { ok: true };
  });
  app.post<P & { Body: { paths?: string[] } }>('/api/projects/:id/git/unstage', async (req) => {
    await git.unstage(root(req.params.id), req.body?.paths ?? []);
    return { ok: true };
  });
  app.post<P & { Body: { paths: string[] } }>('/api/projects/:id/git/discard', async (req) => {
    await git.discard(root(req.params.id), req.body?.paths ?? []);
    return { ok: true };
  });
  app.post<P & { Body: { message: string; all?: boolean } }>('/api/projects/:id/git/commit', async (req) => ({
    output: await git.commit(root(req.params.id), req.body.message, req.body.all ?? true),
  }));
  app.post<P>('/api/projects/:id/git/push', async (req) => ({ output: await git.push(root(req.params.id), pid(req.params.id)) }));
  app.post<P>('/api/projects/:id/git/pull', async (req) => ({ output: await git.pull(root(req.params.id), pid(req.params.id)) }));
  app.post<P & { Body: { branch: string; create?: boolean } }>('/api/projects/:id/git/checkout', async (req) => ({
    output: await git.checkout(root(req.params.id), req.body.branch, !!req.body.create),
  }));

  // ---- terminals ----
  // The project scope lists every terminal (board runs included); a worktree scope narrows to that worktree and opens new ones there.
  app.get<P>('/api/projects/:id/terminals', async (req) => {
    const { project, worktree } = resolveScope(req.params.id);
    const inside = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir + path.sep);
    return { terminals: terminals.list(project.id).filter((t) => !worktree || inside(t.cwd, worktree.path)) };
  });
  app.post<P & { Body: { cwd?: string; command?: string; title?: string; cols?: number; rows?: number } }>(
    '/api/projects/:id/terminals',
    async (req) => {
      const { project, worktree } = resolveScope(req.params.id);
      const body = req.body ?? {};
      const cwd = worktree ? path.posix.join(worktree.relPath, body.cwd ?? '.') : body.cwd;
      return { terminal: terminals.create(project.id, { ...body, cwd }) };
    },
  );
  app.patch<{ Params: { tid: string }; Body: { title: string } }>('/api/terminals/:tid', async (req) => ({
    terminal: terminals.rename(req.params.tid, req.body.title),
  }));
  app.delete<{ Params: { tid: string } }>('/api/terminals/:tid', async (req) => {
    terminals.kill(req.params.tid);
    return { ok: true };
  });
}
