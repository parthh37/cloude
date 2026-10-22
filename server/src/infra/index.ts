import type { FastifyInstance } from 'fastify';
import type {
  CleanerCategory,
  CleanerPolicy,
  EmbeddingConfig,
  InfraOverview,
  ModelProvider,
  RoutingConfig,
  SandboxCreateInput,
  TaskKind,
} from '../../../shared/protocol.js';
import { db } from '../db.js';
import { HttpError } from '../util/paths.js';
import { CATEGORY_ORDER, cleaner, setPolicy } from './cleaner.js';
import { cosine, embeddings } from './embeddings.js';
import { TASK_KINDS, checkProvider, decisions, routingConfig, setRoutingConfig, setSessionTask } from './routing.js';
import { sandboxes } from './sandboxes.js';
import { semantic } from './semantic.js';

/**
 * Infrastructure module: sandboxes, storage cleaner, model routing, embeddings.
 * One registration call from index.ts wires routes and starts the background work.
 * All routes are under /api/, so the auth + origin checks in auth.ts apply.
 */
export function registerInfra(app: FastifyInstance) {
  registerRoutes(app);
  cleaner.start();
  // Autoconfigure embeddings in the background; nothing waits on it.
  setTimeout(() => void embeddings.configure().catch(() => {}), 3000).unref();
  // Vectors of projects that were deleted.
  db.prepare('DELETE FROM infra_chunks WHERE project_id NOT IN (SELECT id FROM projects)').run();
}

function registerRoutes(app: FastifyInstance) {
  app.get('/api/infra/overview', async (): Promise<InfraOverview> => ({
    runtime: await sandboxes.runtimeInfo(),
    sandboxes: sandboxes.list(),
    storage: cleaner.report(),
    routing: routingConfig(),
    taskKinds: TASK_KINDS,
    decisions: decisions(),
    embeddings: embeddings.status(),
  }));

  // ---- sandboxes ----
  app.get<{ Querystring: { projectId?: string; refresh?: string } }>('/api/infra/sandboxes', async (req) => {
    if (req.query.refresh) await sandboxes.reconcile();
    return { sandboxes: sandboxes.list(req.query.projectId || undefined), version: sandboxes.version };
  });
  app.get<{ Querystring: { refresh?: string } }>('/api/infra/runtime', async (req) => ({ runtime: await sandboxes.runtimeInfo(!!req.query.refresh) }));
  app.post<{ Body: SandboxCreateInput }>('/api/infra/sandboxes', async (req) => sandboxes.create({ ...req.body, sessionId: null }));
  app.patch<{ Params: { id: string }; Body: { pinned?: boolean; ttlMinutes?: number | null } }>('/api/infra/sandboxes/:id', async (req) => ({
    sandbox: sandboxes.update(req.params.id, req.body ?? {}),
  }));
  app.post<{ Params: { id: string; action: string }; Body: { snapshotId?: string; label?: string; port?: number; keepSnapshots?: boolean } }>(
    '/api/infra/sandboxes/:id/:action',
    async (req) => {
      const { id, action } = req.params;
      const b = req.body ?? {};
      switch (action) {
        case 'start':
          return { sandbox: await sandboxes.start(id) };
        case 'stop':
          return { sandbox: await sandboxes.stop(id) };
        case 'destroy':
          return { freedBytes: await sandboxes.destroy(id, { keepSnapshots: b.keepSnapshots }) };
        case 'snapshot':
          return { snapshot: await sandboxes.snapshot(id, b.label) };
        case 'restore':
          return { sandbox: await sandboxes.restore(id, String(b.snapshotId ?? '')) };
        case 'delete-snapshot':
          await sandboxes.deleteSnapshot(id, String(b.snapshotId ?? ''));
          return { ok: true };
        case 'expose':
          return { sandbox: await sandboxes.exposePort(id, Number(b.port)) };
        case 'shell':
          return { terminal: await sandboxes.openShell(id) };
        case 'stats':
          return { stats: await sandboxes.stats(id) };
        default:
          throw new HttpError(404, `Unknown action ${action}`);
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { command: string; timeoutSec?: number } }>('/api/infra/sandboxes/:id/exec', async (req) => ({
    result: await sandboxes.exec(req.params.id, String(req.body?.command ?? ''), { timeoutSec: req.body?.timeoutSec ?? 60 }),
  }));

  // ---- storage cleaner ----
  app.get('/api/infra/storage', async () => cleaner.report());
  app.post('/api/infra/storage/scan', async () => {
    await cleaner.scan();
    return cleaner.report();
  });
  app.post<{ Body: { categories?: CleanerCategory[] } }>('/api/infra/storage/clean', async (req) => {
    const p = cleaner.report().policy;
    const cats = (req.body?.categories ?? CATEGORY_ORDER.filter((c) => p.categories[c] !== 'off')).filter((c) => CATEGORY_ORDER.includes(c));
    if (cleaner.busy) throw new HttpError(409, 'A cleanup is already running');
    const run = await cleaner.clean(cats, 'manual');
    await cleaner.scan();
    return { run, report: cleaner.report() };
  });
  app.put<{ Body: Partial<CleanerPolicy> }>('/api/infra/storage/policy', async (req) => {
    setPolicy(req.body ?? {});
    return cleaner.report();
  });

  // ---- model & provider routing ----
  app.get('/api/infra/routing', async () => ({ routing: routingConfig(), taskKinds: TASK_KINDS, decisions: decisions() }));
  app.put<{ Body: Partial<RoutingConfig> }>('/api/infra/routing', async (req) => ({ routing: setRoutingConfig(req.body ?? {}) }));
  app.post<{ Body: ModelProvider }>('/api/infra/routing/check', async (req) => ({ check: await checkProvider(req.body) }));
  app.put<{ Params: { id: string }; Body: { task: TaskKind | null } }>('/api/infra/routing/sessions/:id', async (req) => {
    setSessionTask(req.params.id, req.body?.task ?? null);
    return { ok: true, note: 'Applies the next time the session starts its Claude process (after it goes idle, or Stop).' };
  });

  // ---- embeddings ----
  app.get('/api/infra/embeddings', async () => embeddings.status());
  app.put<{ Body: Partial<EmbeddingConfig> }>('/api/infra/embeddings', async (req) => embeddings.setConfig(req.body ?? {}));
  app.post('/api/infra/embeddings/detect', async () => {
    await embeddings.configure();
    return embeddings.status();
  });
  app.post<{ Body: { a: string; b: string } }>('/api/infra/embeddings/compare', async (req) => {
    const [va, vb] = await embeddings.embed([String(req.body?.a ?? ''), String(req.body?.b ?? '')], 'document');
    return { similarity: Math.round(cosine(va!, vb!) * 1000) / 1000, dimensions: va?.length ?? 0 };
  });
  app.post<{ Body: { projectId: string; query: string; k?: number } }>('/api/infra/embeddings/search', async (req) => ({
    hits: await semantic.search(req.body.projectId, String(req.body.query ?? ''), req.body.k ?? 10),
  }));
  app.post<{ Body: { projectId: string } }>('/api/infra/embeddings/reindex', async (req) => {
    semantic.forget(req.body.projectId);
    return semantic.index(req.body.projectId);
  });
}
