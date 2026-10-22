import type { FastifyInstance } from 'fastify';
import type { SetupStatus } from '../../../shared/protocol.js';
import { createSession, ctxOf } from '../auth.js';
import { claimAdmin, markSetupCompleted, setupStatus } from '../setup.js';

export function registerSetupRoutes(app: FastifyInstance) {
  // Public: the web app asks this before deciding between /setup and /login.
  app.get('/api/setup', async (): Promise<SetupStatus> => setupStatus());

  // Public, but only does anything while the server has no account, and needs the setup code.
  app.post<{ Body: { code?: string; username?: string; password?: string } }>('/api/setup/admin', async (req, reply) => {
    const ctx = ctxOf(req);
    const { code, username, password } = req.body ?? {};
    const user = await claimAdmin(String(code ?? '').slice(0, 256), String(username ?? ''), String(password ?? ''), ctx);
    createSession(reply, user.id, ctx, 'password');
    return { user };
  });

  app.post('/api/setup/complete', async () => {
    markSetupCompleted();
    return setupStatus();
  });
}
