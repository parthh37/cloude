import type { FastifyInstance } from 'fastify';
import type { ServiceDef } from '../../../shared/protocol.js';
import { projects } from '../projects.js';
import { listListeningPorts } from '../services/ports.js';
import { previewUrlForPort, routes } from '../services/routes-store.js';
import { services } from '../services/service-manager.js';
import { tunnels } from '../services/tunnels.js';

type ServiceBody = Partial<Omit<ServiceDef, 'id' | 'projectId' | 'createdAt'>> & { name: string; command: string };

export function registerHostingRoutes(app: FastifyInstance) {
  // ---- services ----
  app.get<{ Querystring: { projectId?: string } }>('/api/services', async (req) => ({ services: services.list(req.query.projectId) }));

  app.post<{ Params: { id: string }; Body: ServiceBody & { start?: boolean } }>('/api/projects/:id/services', async (req) => {
    const b = req.body;
    const def = services.upsert({
      projectId: req.params.id,
      name: b.name,
      kind: b.kind ?? 'dev',
      strategy: b.strategy ?? 'process',
      command: b.command,
      cwd: b.cwd ?? '.',
      port: b.port ?? null,
      env: b.env ?? {},
      autoRestart: b.autoRestart ?? b.kind === 'deploy',
    });
    if (b.start !== false) await services.start(def.id);
    return { service: services.state(services.def(def.id)) };
  });

  app.patch<{ Params: { sid: string }; Body: Partial<ServiceBody> }>('/api/services/:sid', async (req) => {
    const cur = services.def(req.params.sid);
    const def = services.upsert({ ...cur, ...req.body, id: cur.id, projectId: cur.projectId });
    return { service: services.state(def) };
  });

  app.post<{ Params: { sid: string; action: 'start' | 'stop' | 'restart' } }>('/api/services/:sid/:action', async (req, reply) => {
    const { sid, action } = req.params;
    if (action === 'start') await services.start(sid);
    else if (action === 'stop') await services.stop(sid);
    else if (action === 'restart') await services.restart(sid);
    else return reply.code(404).send({ error: 'Unknown action' });
    return { service: services.state(services.def(sid)) };
  });

  app.get<{ Params: { sid: string }; Querystring: { after?: string; limit?: string } }>('/api/services/:sid/logs', async (req) => ({
    lines: services.logs(req.params.sid, Number(req.query.after ?? -1), Math.min(Number(req.query.limit ?? 1000), 3000)),
  }));

  app.delete<{ Params: { sid: string } }>('/api/services/:sid', async (req) => {
    await services.remove(req.params.sid);
    return { ok: true };
  });

  // ---- ports ----
  app.get('/api/ports', async () => ({
    ports: (await listListeningPorts()).map((p) => ({ ...p, previewUrl: previewUrlForPort(p.port) })),
  }));

  // ---- routes (published apps) ----
  app.get('/api/routes', async () => ({ routes: routes.list() }));

  app.post<{
    Body: { label: string; hostname?: string; targetType: 'port' | 'static'; port?: number; staticDir?: string; isPublic: boolean; projectId?: string };
  }>('/api/routes', async (req) => {
    const b = req.body;
    const project = b.projectId ? projects.require(b.projectId) : null;
    return { route: routes.upsert({ ...b, projectRoot: project?.path }) };
  });

  app.patch<{ Params: { rid: string }; Body: { isPublic: boolean } }>('/api/routes/:rid', async (req) => ({
    route: routes.setPublic(req.params.rid, !!req.body.isPublic),
  }));

  app.delete<{ Params: { rid: string } }>('/api/routes/:rid', async (req) => {
    routes.delete(req.params.rid);
    return { ok: true };
  });

  // ---- tunnels ----
  app.get('/api/tunnels', async () => ({ tunnels: tunnels.list() }));
  app.post<{ Body: { port: number } }>('/api/tunnels', async (req) => ({ tunnel: await tunnels.open(Number(req.body.port)) }));
  app.delete<{ Params: { tid: string } }>('/api/tunnels/:tid', async (req) => {
    tunnels.close(req.params.tid);
    return { ok: true };
  });
}
