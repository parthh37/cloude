import type { FastifyInstance } from 'fastify';
import type { SetupStatus } from '../../../shared/protocol.js';
import { rateLimited, startLoginSession } from '../auth.js';
import { claimAdmin, markSetupCompleted, setupStatus } from '../setup.js';

export function registerSetupRoutes(app: FastifyInstance) {
  // Public: the web app asks this before deciding between /setup and /login.
  app.get('/api/setup', async (): Promise<SetupStatus> => setupStatus());

  // Public, but only does anything while the server has no account, and needs the setup code.
  app.post<{ Body: { code?: string; username?: string; password?: string } }>('/api/setup/admin', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts — try again in 15 minutes' });
    const { code, username, password } = req.body ?? {};
    const user = claimAdmin(String(code ?? ''), String(username ?? ''), String(password ?? ''));
    startLoginSession(req, reply, user.id);
    return { user };
  });

  app.post('/api/setup/complete', async () => {
    markSetupCompleted();
    return setupStatus();
  });
}
