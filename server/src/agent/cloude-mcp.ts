import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project, Worktree } from '../../../shared/protocol.js';
import { hub } from '../hub.js';
import { listListeningPorts } from '../services/ports.js';
import { previewUrlForPort, routes } from '../services/routes-store.js';
import { services } from '../services/service-manager.js';
import { tunnels } from '../services/tunnels.js';
import { slugify } from '../util/paths.js';

export const CLOUDE_MCP_NAME = 'cloude';

/** Tools that make something reachable from the internet always need a human click. */
const ALWAYS_ASK = ['publish', 'deploy', 'open_tunnel'];
/** Harmless, read-only tools that never need approval. */
export const CLOUDE_READONLY_TOOLS = ['list_services', 'service_logs', 'list_ports', 'preview_url', 'list_routes', 'notify_user'].map(
  (t) => `mcp__${CLOUDE_MCP_NAME}__${t}`,
);

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  isError,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serviceSummary(projectId: string, name: string, logLines = 40) {
  const def = services.byName(projectId, name);
  if (!def) return null;
  const s = services.state(def);
  return {
    name: s.name,
    status: s.status,
    port: s.port,
    pid: s.pid,
    localUrl: s.port ? `http://localhost:${s.port}` : null,
    previewUrl: s.urls.private ?? null,
    publicUrl: s.urls.public ?? null,
    recentLogs: services
      .logs(def.id, -1, logLines)
      .map((l) => (l.s === 'err' ? `[err] ${l.text}` : l.text))
      .join('\n'),
  };
}

/**
 * In-process MCP server giving Claude control over Cloude's hosting layer for
 * the session's project. Created per session so every tool is scoped to it.
 */
export function createCloudeMcp(project: Project, sessionId: string, worktree: Worktree | null = null): McpSdkServerConfigWithInstance {
  // Worktree sessions get their own service namespace ("web@fix-login") and run
  // services from their worktree, so parallel sessions never restart each other's servers.
  const svcName = (name: string) => (worktree && !name.endsWith(`@${worktree.id}`) ? `${name}@${worktree.id}` : name);
  const svcCwd = (cwd?: string) => (worktree ? path.posix.join(worktree.relPath, cwd ?? '.') : (cwd ?? '.'));
  const server = createSdkMcpServer({
    name: CLOUDE_MCP_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Cloude hosting tools. Use start_service for anything long-running (dev servers, watchers, APIs) instead of backgrounding with `&` in Bash — ' +
      'services survive the turn, stream logs to the user, and get preview URLs. Test web UIs with the browser tools against the localUrl. ' +
      'publish / deploy / open_tunnel expose things to the internet and always require the user to approve.',
    tools: [
      tool('list_services', 'List services (dev servers and deployments) defined for this project with status, ports and URLs.', {}, async () =>
        text(services.list(project.id).map((s) => ({ name: s.name, kind: s.kind, status: s.status, port: s.port, urls: s.urls, command: s.command }))),
      ),

      tool(
        'start_service',
        'Create or update a long-running process for this project and start it (e.g. `npm run dev`). $PORT is set for the process; ' +
          'pass `port` if the app needs a specific port. Returns status, URLs and the first log lines after a few seconds.',
        {
          name: z.string().describe('Short identifier, e.g. "web" or "api"'),
          command: z.string().describe('Shell command, run with bash -lc'),
          cwd: z.string().optional().describe('Directory relative to the project root (default ".")'),
          port: z.number().int().optional().describe('Port the app listens on; also exported as $PORT'),
          env: z.record(z.string(), z.string()).optional(),
          restart: z.boolean().optional().describe('Restart if already running (default true)'),
        },
        async (args) => {
          const name = svcName(args.name);
          const def = services.upsert({
            projectId: project.id,
            name,
            kind: services.byName(project.id, name)?.kind ?? 'dev',
            strategy: 'process',
            command: args.command,
            cwd: svcCwd(args.cwd),
            port: args.port ?? null,
            env: args.env ?? {},
            autoRestart: false,
          });
          if (args.restart === false) await services.start(def.id);
          else await services.restart(def.id);
          await sleep(4000);
          return text(serviceSummary(project.id, name));
        },
      ),

      tool('stop_service', 'Stop a running service.', { name: z.string() }, async (args) => {
        const name = services.byName(project.id, svcName(args.name)) ? svcName(args.name) : args.name;
        const def = services.byName(project.id, name);
        if (!def) return text(`No service named "${name}"`, true);
        await services.stop(def.id);
        return text(`Stopped ${name}`);
      }),

      tool('restart_service', 'Restart a service (e.g. after changing config).', { name: z.string() }, async (args) => {
        const name = services.byName(project.id, svcName(args.name)) ? svcName(args.name) : args.name;
        const def = services.byName(project.id, name);
        if (!def) return text(`No service named "${name}"`, true);
        await services.restart(def.id);
        await sleep(3000);
        return text(serviceSummary(project.id, name));
      }),

      tool(
        'service_logs',
        'Read recent stdout/stderr of a service.',
        { name: z.string(), lines: z.number().int().min(1).max(2000).optional() },
        async ({ name: raw, lines }) => {
          const name = services.byName(project.id, svcName(raw)) ? svcName(raw) : raw;
          const def = services.byName(project.id, name);
          if (!def) return text(`No service named "${name}"`, true);
          const out = services
            .logs(def.id, -1, lines ?? 200)
            .map((l) => (l.s === 'err' ? `[err] ${l.text}` : l.s === 'sys' ? `[cloude] ${l.text}` : l.text));
          return text(out.join('\n') || '(no output yet)');
        },
      ),

      tool('list_ports', 'List TCP ports currently listening on the server, with owning process and preview URL.', {}, async () => {
        const ports = await listListeningPorts();
        return text(ports.map((p) => ({ ...p, localUrl: `http://localhost:${p.port}`, previewUrl: previewUrlForPort(p.port) })));
      }),

      tool(
        'preview_url',
        'Get the private preview URL (login-protected) the user can open to see an app on a local port.',
        { port: z.number().int() },
        async ({ port }) =>
          text({
            previewUrl: previewUrlForPort(port),
            localUrl: `http://localhost:${port}`,
            note: 'Share previewUrl with the user. Use localUrl yourself (curl, browser tools).',
          }),
      ),

      tool('list_routes', 'List published routes (subdomains / custom domains) and whether they are public.', {}, async () =>
        text(routes.list().map((r) => ({ name: r.label, url: r.url, public: r.isPublic, target: r.targetType === 'port' ? r.port : r.staticDir }))),
      ),

      tool(
        'publish',
        'Publish a local port or a static directory at <name>.<preview domain>. public=true makes it reachable by anyone ' +
          'without logging in. Requires user approval.',
        {
          name: z.string().describe('Subdomain label, e.g. "myapp"'),
          port: z.number().int().optional(),
          staticDir: z.string().optional().describe('Directory relative to the project root, e.g. "dist"'),
          public: z.boolean().default(true),
          hostname: z.string().optional().describe('Optional custom domain already pointing at this server'),
        },
        async (args) => {
          if (!args.port && !args.staticDir) return text('Provide either port or staticDir', true);
          const r = routes.upsert({
            label: slugify(args.name),
            hostname: args.hostname ?? null,
            targetType: args.staticDir ? 'static' : 'port',
            port: args.port ?? null,
            staticDir: args.staticDir ? svcCwd(args.staticDir) : null,
            isPublic: args.public,
            projectId: project.id,
            projectRoot: project.path,
          });
          return text({ url: r.url, public: r.isPublic });
        },
      ),

      tool(
        'deploy',
        'Deploy this project as a persistent service that auto-restarts and survives server reboots, and publish it. ' +
          'strategy "process": run `command` (build first with Bash). "docker": build the Dockerfile in cwd and run it (app must listen on $PORT). ' +
          '"static": serve `command` as a directory (e.g. "dist"). Requires user approval.',
        {
          name: z.string(),
          strategy: z.enum(['process', 'docker', 'static']),
          command: z.string().describe('process: start command; docker: extra `docker run` args (may be ""); static: directory'),
          cwd: z.string().optional(),
          port: z.number().int().optional(),
          env: z.record(z.string(), z.string()).optional(),
          subdomain: z.string().optional().describe('Defaults to the service name'),
          public: z.boolean().default(true),
          hostname: z.string().optional(),
        },
        async (args) => {
          const name = svcName(args.name);
          const def = services.upsert({
            projectId: project.id,
            name,
            kind: 'deploy',
            strategy: args.strategy,
            command: args.command,
            cwd: svcCwd(args.cwd),
            port: args.port ?? null,
            env: args.env ?? {},
            autoRestart: args.strategy !== 'static',
          });
          await services.restart(def.id);
          const label = slugify(args.subdomain ?? args.name);
          if (args.strategy === 'static') {
            const staticDir = services.staticDir(def); // absolute: project root + cwd + dir
            routes.upsert({ label, hostname: args.hostname, targetType: 'static', staticDir, isPublic: args.public, projectId: project.id, projectRoot: project.path });
          } else {
            // Wait for the port (docker builds can take a while).
            let port: number | null = null;
            for (let i = 0; i < 60 && !port; i++) {
              await sleep(2000);
              const st = services.state(services.def(def.id));
              if (st.status === 'crashed') break;
              if (st.status === 'running') port = st.port;
            }
            if (!port) return text({ error: 'Service did not start listening on a port', ...serviceSummary(project.id, name, 80) }, true);
            routes.upsert({ label, hostname: args.hostname, targetType: 'port', port, isPublic: args.public, projectId: project.id });
          }
          return text(serviceSummary(project.id, name));
        },
      ),

      tool('unpublish', 'Remove a published route by name.', { name: z.string() }, async ({ name }) => {
        routes.deleteByLabel(slugify(name));
        return text(`Unpublished ${name}`);
      }),

      tool(
        'open_tunnel',
        'Open a temporary public https URL (Cloudflare quick tunnel) for a local port — works even without a configured domain. Requires user approval.',
        { port: z.number().int() },
        async ({ port }) => {
          const t = await tunnels.open(port);
          return text({ url: t.url, note: 'Temporary; closes when stopped or when the server restarts.' });
        },
      ),

      tool(
        'notify_user',
        'Send a notification to the user\'s browser (e.g. when a long task finishes or you need their attention).',
        { title: z.string(), body: z.string().optional(), level: z.enum(['info', 'success', 'warning', 'error']).optional() },
        async ({ title, body, level }) => {
          hub.broadcast({ t: 'notify', level: level ?? 'info', title, body, sessionId });
          return text('Notification sent');
        },
      ),
    ],
  });
  // Server-side permission policy: outward-facing tools ask even under bypassPermissions.
  server.tools = ALWAYS_ASK.map((name) => ({ name, permission_policy: 'always_ask' as const }));
  return server;
}
