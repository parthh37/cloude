import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage } from '../../shared/protocol.js';
import { sessions } from './agent/session.js';
import { pruneSecurityEvents } from './auth/audit.js';
import { pruneThrottle } from './auth/throttle.js';
import { authFromRaw, ensureAdmin, isAllowedOrigin, pruneAuthSessions, registerAuth, trackSocket } from './auth.js';
import { config } from './config.js';
import { hub } from './hub.js';
import { startMonitor } from './monitor.js';
import { handlePreviewRequest, handlePreviewUpgrade, registerPreviewRoutes } from './proxy/preview-proxy.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHostingRoutes } from './routes/hosting.js';
import { registerProjectAndSessionRoutes } from './routes/sessions.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { services } from './services/service-manager.js';
import { tunnels } from './services/tunnels.js';
import { terminals } from './terminal/terminals.js';
import { registerInfra } from './infra/index.js';
import { HttpError } from './util/paths.js';

await ensureAdmin();

// One HTTP server, three tenants: the preview proxy (decided by Host header),
// WebSockets (upgrade), and the Fastify app for everything else.
const app = Fastify({
  // Only the local reverse proxy (Caddy) may set X-Forwarded-For; otherwise clients could
  // spoof their IP and dodge the login rate limit.
  trustProxy: config.trustProxy ? 'loopback' : false,
  bodyLimit: 10 * 1024 * 1024,
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  serverFactory: (handler) =>
    http.createServer((req, res) => {
      if (handlePreviewRequest(req, res)) return;
      handler(req, res);
    }),
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 50 } });

app.setErrorHandler((err: Error & { statusCode?: number; retryAfter?: number }, _req, reply) => {
  const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
  if (status >= 500) app.log.error(err);
  if (err.retryAfter) reply.header('retry-after', String(err.retryAfter));
  reply.code(status).send({ error: status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) });
});

registerAuth(app);
registerAuthRoutes(app);
registerSystemRoutes(app);
registerPreviewRoutes(app);
registerProjectAndSessionRoutes(app);
registerInfra(app); // sandboxes, storage cleaner, model routing, embeddings
registerWorkspaceRoutes(app);
registerHostingRoutes(app);

// ---- web UI (single-page app) ----
const hasWeb = fs.existsSync(path.join(config.webDist, 'index.html'));
if (hasWeb) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false });
  app.get('/assets/*', (req, reply) => reply.sendFile((req.params as { '*': string })['*'], path.join(config.webDist, 'assets'), { maxAge: '365d', immutable: true }));
}
app.setNotFoundHandler((req, reply) => {
  if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
  if (!hasWeb) return reply.type('text/plain').send('Cloude API is running. Build the web UI with `npm run build` (or use `npm run dev`).');
  const rel = req.url.split('?')[0]!.replace(/^\/+/, '');
  const file = path.resolve(config.webDist, rel);
  const inside = file.startsWith(config.webDist + path.sep);
  if (rel && inside && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(rel);
  reply.header('cache-control', 'no-cache');
  return reply.sendFile('index.html');
});

// ---- WebSockets ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

function handleEventsSocket(ws: WebSocket) {
  const client = hub.add(ws);
  hub.send(client, { t: 'hello', serverTime: Date.now() });
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'sub') {
      try {
        const s = sessions.get(msg.sessionId);
        client.subs.add(msg.sessionId); // subscribe first; the client de-dupes by seq
        for (const event of s.events(Number(msg.after) || 0)) hub.send(client, { t: 'event', event });
        hub.send(client, { t: 'pending', sessionId: s.id, requests: s.pendingRequests() });
        hub.send(client, { t: 'session', session: s.toJSON() });
      } catch (e) {
        hub.send(client, { t: 'error', message: (e as Error).message });
      }
    } else if (msg.t === 'unsub') {
      client.subs.delete(msg.sessionId);
    } else if (msg.t === 'watch' && (msg.topic === 'metrics' || msg.topic === 'processes')) {
      if (msg.on) client.watching.add(msg.topic);
      else client.watching.delete(msg.topic);
    }
  });
}

app.server.on('upgrade', (req, socket, head) => {
  if (handlePreviewUpgrade(req, socket, head)) return;
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  const auth = pathname.startsWith('/ws') && isAllowedOrigin(req) ? authFromRaw(req) : null;
  if (!auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    trackSocket(auth.sid, ws); // revoking this login closes the socket
    const term = /^\/ws\/terminal\/([\w-]+)$/.exec(pathname);
    if (pathname === '/ws') handleEventsSocket(ws);
    else if (term) terminals.attach(term[1]!, ws);
    else ws.close(4404, 'unknown endpoint');
  });
});

// Keep idle sockets alive through reverse proxies (Caddy/nginx/Cloudflare).
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping();
}, 25_000).unref();
setInterval(pruneAuthSessions, 60_000).unref();
setInterval(() => {
  pruneThrottle();
  pruneSecurityEvents();
}, 60 * 60_000).unref();
startMonitor();

// ---- lifecycle ----
await app.listen({ host: config.host, port: config.port });
console.log(`\n  ☁️  Cloude ${config.version} listening on http://${config.host}:${config.port}`);
console.log(`     public URL:     ${config.publicUrl}`);
console.log(`     previews:       ${config.previewDomain ? `https://p-<port>.${config.previewDomain}` : `${config.publicUrl}/preview/<port>/ (set CLOUDE_PREVIEW_DOMAIN for subdomains)`}`);
console.log(`     workspaces:     ${config.workspacesDir}\n`);

void services.bootstrap();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[cloude] ${signal} received, shutting down…`);
  sessions.stopAll();
  terminals.killAll();
  tunnels.closeAll();
  await Promise.race([services.stopAll(), new Promise((r) => setTimeout(r, 8000))]);
  await app.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
