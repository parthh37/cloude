import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import mime from 'mime-types';
import { createProxyServer } from 'http-proxy-3';
import { SESSION_COOKIE, effectiveHost, isSafeRedirectPath, parseCookies, userFromRaw, userFromSessionId } from '../auth.js';
import { config, originFor } from '../config.js';
import { signToken, verifyToken } from '../crypto.js';
import { routes } from '../services/routes-store.js';

/**
 * Preview & hosting proxy.
 *
 * Host-based routing (requires a wildcard DNS record → this server):
 *   p-<port>.<previewDomain>   private preview of any local port (login required)
 *   <label>.<previewDomain>    a named route (private or public)
 *   <custom hostname>          a named route with a custom domain
 * Path-based fallback on the main host (no DNS needed, less compatible):
 *   /preview/<port>/…          private preview
 *   /apps/<label>/…            named route
 *
 * Private previews never see Cloude's session cookie. Instead a signed,
 * host-bound token is handed off once and exchanged for a host-only cookie.
 */

const PREVIEW_COOKIE = 'cloude_preview';
const PREVIEW_COOKIE_TTL = 7 * 24 * 60 * 60 * 1000;

type Target =
  | { kind: 'port'; port: number; isPublic: boolean }
  | { kind: 'static'; dir: string; isPublic: boolean }
  | { kind: 'missing'; label: string };

interface Resolved {
  host: string;
  mode: 'subdomain' | 'custom' | 'path';
  target: Target;
  /** For path mode: the prefix stripped before forwarding. */
  prefix: string;
}

const proxy = createProxyServer({ xfwd: true, changeOrigin: true, autoRewrite: true, ws: true });

/**
 * Path-mode previews (/preview/<port>/, /apps/<name>/) are served from Cloude's
 * own origin. A CSP sandbox gives the document an opaque origin so the
 * previewed app cannot call the Cloude API or script the Cloude UI. Trade-off:
 * sandboxed pages can't use cookies/localStorage — use a wildcard preview
 * domain for full compatibility.
 */
const PATH_MODE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

proxy.on('proxyRes', (proxyRes: IncomingMessage, req: IncomingMessage) => {
  if (!(req as any).__cloudeSandbox) return;
  const existing = proxyRes.headers['content-security-policy'];
  proxyRes.headers['content-security-policy'] = existing ? `${existing}, ${PATH_MODE_SANDBOX}` : PATH_MODE_SANDBOX;
});

proxy.on('error', (err: Error, req: IncomingMessage, res: ServerResponse | Duplex) => {
  if ('writeHead' in res && typeof res.writeHead === 'function') {
    if (!res.headersSent) {
      const port = (req as any).__cloudePort as number | undefined;
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(waitingPage(port, err.message));
    } else res.end();
  } else {
    (res as Duplex).destroy();
  }
});

function waitingPage(port: number | undefined, detail: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Waiting for port ${port ?? ''}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0b0d10;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:440px;padding:28px;border:1px solid #222831;border-radius:14px;background:#11151a}
code{background:#1b2129;padding:2px 6px;border-radius:6px}small{color:#6b7684}</style></head>
<body><div class="card"><h2 style="margin-top:0">Nothing is listening on port ${port ?? '?'} yet</h2>
<p>Start the dev server (or ask Claude to), and this page will reload automatically.</p>
<small>${escapeHtml(detail)}</small></div></body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function requestHost(req: IncomingMessage): string {
  return effectiveHost(req).toLowerCase().replace(/:\d+$/, '');
}

const mainHost = () => config.publicHost.toLowerCase().replace(/:\d+$/, '');

function routeTarget(label: string): Target {
  const r = routes.byLabel(label);
  if (!r) return { kind: 'missing', label };
  if (r.targetType === 'static') return { kind: 'static', dir: r.staticDir!, isPublic: r.isPublic };
  return { kind: 'port', port: r.port!, isPublic: r.isPublic };
}

/** Cloude's own ports (the API, the desktop's VNC) are never previewable, even by a logged-in user's browser. */
function portTarget(port: number): Target {
  return config.reservedPorts.has(port) ? { kind: 'missing', label: `p-${port}` } : { kind: 'port', port, isPublic: false };
}

export function resolvePreview(req: IncomingMessage): Resolved | null {
  const host = requestHost(req);
  const pd = config.previewDomain?.toLowerCase();

  if (pd && host.endsWith('.' + pd)) {
    const label = host.slice(0, -(pd.length + 1));
    const m = /^p-(\d{2,5})$/.exec(label);
    if (m) return { host, mode: 'subdomain', prefix: '', target: portTarget(Number(m[1])) };
    if (label.includes('.')) return null;
    return { host, mode: 'subdomain', prefix: '', target: routeTarget(label) };
  }

  if (host !== mainHost() && host !== 'localhost' && host !== '127.0.0.1') {
    const r = routes.byHostname(host);
    if (r) {
      const target: Target =
        r.targetType === 'static'
          ? { kind: 'static', dir: r.staticDir!, isPublic: r.isPublic }
          : { kind: 'port', port: r.port!, isPublic: r.isPublic };
      return { host, mode: 'custom', prefix: '', target };
    }
  }

  const url = req.url ?? '/';
  let m = /^\/preview\/(\d{2,5})(?=\/|$|\?)/.exec(url);
  if (m) return { host, mode: 'path', prefix: m[0], target: portTarget(Number(m[1])) };
  m = /^\/apps\/([a-z0-9-]+)(?=\/|$|\?)/.exec(url);
  if (m) return { host, mode: 'path', prefix: m[0], target: routeTarget(m[1]!) };
  return null;
}

/** Remove Cloude's own cookies before a request reaches user code. */
function stripCloudeCookies(req: IncomingMessage) {
  const cookie = req.headers.cookie;
  if (!cookie) return;
  const kept = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${PREVIEW_COOKIE}=`));
  if (kept.length) req.headers.cookie = kept.join('; ');
  else delete req.headers.cookie;
}

function isAuthorized(req: IncomingMessage, r: Resolved): boolean {
  if (r.target.kind !== 'missing' && r.target.isPublic) return true;
  if (r.mode === 'path') return !!userFromRaw(req);
  const token = parseCookies(req.headers.cookie)[PREVIEW_COOKIE];
  const data = token ? verifyToken<{ host: string; purpose: string }>(token) : null;
  return !!data && data.purpose === 'preview' && data.host === r.host;
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, sandbox: boolean) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const root = path.resolve(dir);
  let file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    /* fall through to SPA fallback */
  }
  if (!fs.existsSync(file)) {
    const ext = path.extname(pathname);
    file = path.join(root, 'index.html'); // SPA fallback for client-side routes
    if (ext && ext !== '.html') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const type = mime.lookup(file) || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...(sandbox ? { 'content-security-policy': PATH_MODE_SANDBOX } : {}),
    'content-type': mime.contentType(type) || type,
    'content-length': stat.size,
    'cache-control': type === 'text/html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

/** Returns true if the request was a preview request and has been handled. */
export function handlePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const r = resolvePreview(req);
  if (!r) return false;

  if (r.target.kind === 'missing') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`No app is published as "${r.target.label}".`);
    return true;
  }

  // Path mode needs the trailing slash so relative asset URLs resolve under the prefix.
  if (r.mode === 'path' && (req.url === r.prefix || req.url?.startsWith(r.prefix + '?'))) {
    redirect(res, r.prefix + '/' + (req.url!.slice(r.prefix.length) || ''));
    return true;
  }

  // Token handoff endpoint for host-based private previews.
  const url = new URL(req.url ?? '/', 'http://x');
  if (r.mode !== 'path' && url.pathname === '/__cloude_auth') {
    const handoff = verifyToken<{ host: string; purpose: string }>(url.searchParams.get('token') ?? '');
    if (!handoff || handoff.purpose !== 'preview-handoff' || handoff.host !== r.host) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Invalid or expired preview link. Open it again from Cloude.');
      return true;
    }
    const cookie = signToken({ host: r.host, purpose: 'preview' }, PREVIEW_COOKIE_TTL);
    const next = url.searchParams.get('next') ?? '/';
    res.writeHead(302, {
      'set-cookie': `${PREVIEW_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_COOKIE_TTL / 1000}${config.secure ? '; Secure' : ''}`,
      location: isSafeRedirectPath(next) ? next : '/',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  if (!isAuthorized(req, r)) {
    if (r.mode === 'path') redirect(res, `/login?next=${encodeURIComponent(req.url ?? '/')}`);
    else {
      const qs = new URLSearchParams({ host: r.host, next: req.url ?? '/' });
      redirect(res, `${config.publicUrl}/api/preview-auth?${qs}`);
    }
    return true;
  }

  stripCloudeCookies(req);
  if (r.prefix) req.url = req.url!.slice(r.prefix.length) || '/';
  const sandbox = r.mode === 'path';
  (req as any).__cloudeSandbox = sandbox;

  if (r.target.kind === 'static') {
    serveStatic(req, res, r.target.dir, sandbox);
    return true;
  }
  (req as any).__cloudePort = r.target.port;
  proxy.web(req, res, { target: `http://127.0.0.1:${r.target.port}` });
  return true;
}

/** WebSocket upgrades (HMR, socket.io, …). Cookie auth only — no redirects possible. */
export function handlePreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const r = resolvePreview(req);
  if (!r) return false;
  if (r.target.kind !== 'port' || !isAuthorized(req, r)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }
  stripCloudeCookies(req);
  if (r.prefix) req.url = req.url!.slice(r.prefix.length) || '/';
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${r.target.port}` });
  return true;
}

function isPreviewHost(host: string): boolean {
  const pd = config.previewDomain?.toLowerCase();
  if (pd && host.endsWith('.' + pd) && !host.slice(0, -(pd.length + 1)).includes('.')) return true;
  return !!routes.byHostname(host);
}

export function registerPreviewRoutes(app: FastifyInstance) {
  // Step 1 of the handoff: runs on the main host where the session cookie lives.
  app.get<{ Querystring: { host?: string; next?: string } }>('/api/preview-auth', async (req, reply) => {
    const user = userFromSessionId(req.cookies[SESSION_COOKIE]);
    if (!user) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    const host = String(req.query.host ?? '').toLowerCase();
    if (!isPreviewHost(host)) return reply.code(400).send({ error: 'Not a preview host' });
    const token = signToken({ host, purpose: 'preview-handoff' }, 60_000);
    const qs = new URLSearchParams({ token, next: String(req.query.next ?? '/') });
    return reply.redirect(`${routes.byHostname(host) ? `${config.secure ? 'https' : 'http'}://${host}` : originFor(host)}/__cloude_auth?${qs}`);
  });

  // Caddy on-demand TLS: only issue certificates for hosts we actually serve.
  app.get<{ Querystring: { domain?: string } }>('/api/tls-ask', async (req, reply) => {
    const domain = String(req.query.domain ?? '').toLowerCase();
    if (domain === mainHost()) return { ok: true };
    const pd = config.previewDomain?.toLowerCase();
    if (pd && domain.endsWith('.' + pd)) {
      const label = domain.slice(0, -(pd.length + 1));
      if (/^p-\d{2,5}$/.test(label) || routes.byLabel(label)) return { ok: true };
    }
    if (routes.byHostname(domain)) return { ok: true };
    return reply.code(404).send({ ok: false });
  });
}
