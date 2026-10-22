import type { FastifyInstance } from 'fastify';
import type { EffortLevel, ImageAttachment, PermissionMode, PermissionResponse } from '../../../shared/protocol.js';
import { KNOWN_MODELS, sessions } from '../agent/session.js';
import { projects } from '../projects.js';
import { services } from '../services/service-manager.js';
import { terminals } from '../terminal/terminals.js';
import { HttpError } from '../util/paths.js';

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function registerProjectAndSessionRoutes(app: FastifyInstance) {
  // ---- projects ----
  app.get('/api/projects', async () => ({ projects: projects.list() }));

  app.post<{ Body: { name: string; gitUrl?: string; existingPath?: string; branch?: string } }>('/api/projects', async (req) => ({
    project: await projects.create(req.body ?? ({} as any)),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => ({ project: projects.require(req.params.id) }));

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/projects/:id', async (req) => ({
    project: projects.update(req.params.id, req.body ?? {}),
  }));

  app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>('/api/projects/:id', async (req) => {
    const id = req.params.id;
    for (const s of sessions.list(id, true)) await sessions.delete(s.id);
    for (const svc of services.list(id)) await services.remove(svc.id);
    terminals.killProject(id);
    projects.delete(id, req.query.deleteFiles === 'true');
    return { ok: true };
  });

  // ---- sessions ----
  app.get('/api/models', async () => ({ models: KNOWN_MODELS }));

  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>('/api/projects/:id/sessions', async (req) => ({
    sessions: sessions.list(req.params.id, req.query.archived === 'true'),
  }));

  app.get('/api/sessions', async () => ({ sessions: sessions.list(undefined, false) }));

  app.post<{
    Params: { id: string };
    Body: { title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | null; message?: string };
  }>('/api/projects/:id/sessions', async (req) => {
    const body = req.body ?? {};
    if (body.permissionMode && !PERMISSION_MODES.includes(body.permissionMode)) throw new HttpError(400, 'Invalid permission mode');
    const s = sessions.create(req.params.id, body);
    if (body.message?.trim()) s.send(body.message);
    return { session: s.toJSON() };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const s = sessions.get(req.params.id);
    return { session: s.toJSON(), info: s.info, pending: s.pendingRequests() };
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; model?: string | null; permissionMode?: PermissionMode; effort?: EffortLevel | null; archived?: boolean };
  }>('/api/sessions/:id', async (req) => {
    const s = sessions.get(req.params.id);
    const b = req.body ?? {};
    if (b.title !== undefined) s.save({ title: b.title.trim().slice(0, 120) || 'Untitled' });
    if (b.archived !== undefined) {
      if (b.archived) s.stop();
      s.save({ archived: b.archived ? 1 : 0 });
    }
    if (b.model !== undefined) await s.setModel(b.model);
    if (b.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(b.permissionMode)) throw new HttpError(400, 'Invalid permission mode');
      await s.setPermissionMode(b.permissionMode);
    }
    if (b.effort !== undefined) {
      if (b.effort !== null && !EFFORTS.includes(b.effort)) throw new HttpError(400, 'Invalid effort');
      await s.setEffort(b.effort);
    }
    return { session: s.toJSON() };
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    await sessions.delete(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/api/sessions/:id/events', async (req) => ({
    events: sessions.get(req.params.id).events(Number(req.query.after ?? 0), Math.min(Number(req.query.limit ?? 5000), 20000)),
  }));

  app.post<{ Params: { id: string }; Body: { text: string; images?: ImageAttachment[] } }>(
    '/api/sessions/:id/messages',
    { bodyLimit: 40 * 1024 * 1024 },
    async (req) => {
      const s = sessions.get(req.params.id);
      const images = (req.body?.images ?? []).filter((i) => IMAGE_TYPES.has(i.mediaType) && typeof i.data === 'string');
      if (s.row.archived) s.save({ archived: 0 });
      s.send(String(req.body?.text ?? ''), images);
      return { session: s.toJSON() };
    },
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req) => {
    await sessions.get(req.params.id).interrupt();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (req) => {
    sessions.get(req.params.id).stop();
    return { ok: true };
  });

  app.post<{ Params: { id: string; reqId: string }; Body: PermissionResponse }>('/api/sessions/:id/permissions/:reqId', async (req) => {
    const ok = sessions.get(req.params.id).resolvePermission(req.params.reqId, req.body);
    if (!ok) throw new HttpError(404, 'Request already resolved or expired');
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { uuid: string; dryRun?: boolean } }>('/api/sessions/:id/rewind', async (req) => ({
    result: await sessions.get(req.params.id).rewindFiles(req.body.uuid, !!req.body.dryRun),
  }));

  app.get<{ Params: { id: string } }>('/api/sessions/:id/commands', async (req) => {
    const s = sessions.get(req.params.id);
    await s.refreshCommands();
    return { commands: s.info.commands ?? (s.info.slashCommands ?? []).map((name) => ({ name, description: '', argumentHint: '' })) };
  });
}
