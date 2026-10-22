import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project, Sandbox, SandboxExecResult } from '../../../shared/protocol.js';
import { CATEGORY_ORDER, cleaner } from './cleaner.js';
import { embeddings } from './embeddings.js';
import { sandboxes } from './sandboxes.js';
import { semantic } from './semantic.js';

export const INFRA_MCP_NAME = 'infra';
const t = (name: string) => `mcp__${INFRA_MCP_NAME}__${name}`;

/**
 * Tools that act only inside disposable sandboxes, or only read. They run without
 * prompts in every permission mode: a sandbox is the place where Claude is MEANT to
 * have full control. The two ways a sandbox can reach the real project (an `rw`
 * mount, copying files out) are forced back to a human by infraHooks().
 */
export const INFRA_AUTO_TOOLS = [
  'sandbox_runtimes',
  'sandbox_list',
  'sandbox_create',
  'sandbox_exec',
  'sandbox_read_file',
  'sandbox_write_file',
  'sandbox_copy',
  'sandbox_expose_port',
  'sandbox_snapshot',
  'sandbox_restore',
  'sandbox_lifecycle',
  'sandbox_stats',
  'sandbox_shell',
  'storage_report',
  'semantic_search',
].map(t);

export const INFRA_TOOL = { create: t('sandbox_create'), copy: t('sandbox_copy'), clean: t('storage_clean') };

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  isError,
});

/** Turn thrown errors into tool errors Claude can read and recover from. */
const safe =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  };

function brief(s: Sandbox) {
  return {
    name: s.name,
    status: s.status,
    image: s.image,
    isolation: s.isolation,
    mount: s.mount,
    network: s.network === 'project' ? `project network (reach peers as http://<name>:<port>)` : 'isolated (no network)',
    ports: s.ports.map((p) => ({ container: p.container, hostUrl: `http://127.0.0.1:${p.host}`, previewUrl: p.previewUrl })),
    limits: s.limits,
    pinned: s.pinned,
    snapshots: s.snapshots.map((x) => x.label),
  };
}

function execText(r: SandboxExecResult & { logFile?: string }) {
  const parts = [`exit code: ${r.code}  (${(r.durationMs / 1000).toFixed(1)}s)`];
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (r.truncated) parts.push('(output was truncated — redirect to a file and read parts of it)');
  return text(parts.join('\n'), r.code !== 0);
}

/** One instance per Claude session: every tool is scoped to the session's project, and sandboxes it creates are owned by it. */
export function createInfraMcp(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const find = (name: string) => sandboxes.resolve(project.id, name);
  return createSdkMcpServer({
    name: INFRA_MCP_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Disposable sandboxes (containers or microVMs) where you have full root control: install system packages, run databases and ' +
      'services, change kernel-level settings, test destructive or OS-specific behaviour, try other distros — without touching this server. ' +
      'Create one with sandbox_create, run commands with sandbox_exec, publish ports for testing, snapshot before risky steps. ' +
      'Sandboxes in a project share a private network and reach each other by name. Destroy them when you are done; idle ones are ' +
      'stopped and reclaimed automatically. semantic_search finds code by meaning in this project.',
    tools: [
      tool('sandbox_runtimes', 'Show which isolation levels and images are available on this host, and the sandbox quota.', {}, safe(async () => text(await sandboxes.runtimeInfo()))),

      tool('sandbox_list', "List this project's sandboxes with status, ports and snapshots.", {}, safe(async () => text(sandboxes.list(project.id).map(brief)))),

      tool(
        'sandbox_create',
        'Create a sandbox machine you fully control (root). By default it gets a private COPY of the project at /workspace, so ' +
          'nothing you do there changes the real files. Ports listed in `ports` are published to free host ports for browser/curl testing.',
        {
          name: z.string().describe('Short name, a-z0-9- (e.g. "pg", "e2e"); other sandboxes reach it at this hostname'),
          image: z.string().optional().describe('Docker image, default ubuntu:24.04 (see sandbox_runtimes for presets)'),
          isolation: z.enum(['container', 'gvisor', 'system', 'microvm']).optional().describe('container (default), gvisor, system (systemd + Docker inside), microvm (own kernel)'),
          ports: z.array(z.number().int()).optional().describe('Container ports to publish, e.g. [3000, 5432]'),
          mount: z.enum(['copy', 'ro', 'rw', 'none']).optional().describe('copy (default) | ro (live, read-only) | rw (live, read-write — asks the user) | none'),
          network: z.enum(['project', 'isolated']).optional().describe('project (default: internet + peers) or isolated (no network at all)'),
          cpus: z.number().optional(),
          memoryMb: z.number().int().optional(),
          caps: z.array(z.enum(['NET_ADMIN', 'NET_RAW', 'SYS_PTRACE', 'SYS_NICE', 'IPC_LOCK'])).optional().describe('Extra capabilities (e.g. SYS_PTRACE for strace/gdb)'),
          env: z.record(z.string(), z.string()).optional(),
          init: z.string().optional().describe('Setup command run once after boot (e.g. "apt-get update && apt-get install -y postgresql")'),
          ttlMinutes: z.number().int().optional().describe('Destroy after this many idle minutes (default: server policy)'),
        },
        safe(async (args) => {
          const { sandbox, init } = await sandboxes.create({ ...args, projectId: project.id, sessionId } as Parameters<typeof sandboxes.create>[0]);
          const out: Record<string, unknown> = { created: brief(sandbox) };
          if (init) out.init = { exitCode: init.code, output: `${init.stdout}\n${init.stderr}`.trim().slice(-4000) };
          return text(out, !!init && init.code !== 0);
        }),
      ),

      tool(
        'sandbox_exec',
        'Run a shell command inside a sandbox as root (bash -lc, cwd /workspace). Use background=true for servers and long jobs: ' +
          'output goes to a log file you can read with sandbox_read_file.',
        {
          name: z.string(),
          command: z.string(),
          cwd: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          timeoutSec: z.number().int().min(1).max(1800).optional().describe('Default 120'),
          background: z.boolean().optional(),
          user: z.string().optional().describe('Run as this user instead of root'),
        },
        safe(async ({ name, command, ...opts }) => execText(await sandboxes.exec(find(name).id, command, opts))),
      ),

      tool(
        'sandbox_read_file',
        'Read a file inside a sandbox (e.g. a log written by a background job).',
        { name: z.string(), path: z.string(), maxBytes: z.number().int().optional() },
        safe(async ({ name, path, maxBytes }) => {
          const r = await sandboxes.readFile(find(name).id, path, maxBytes);
          return text(r.truncated ? `${r.content}\n… [${r.size} bytes total; showing the first ${r.content.length}]` : r.content || '(empty file)');
        }),
      ),

      tool(
        'sandbox_write_file',
        'Write a file inside a sandbox (parent directories are created).',
        { name: z.string(), path: z.string(), content: z.string() },
        safe(async ({ name, path, content }) => {
          await sandboxes.writeFile(find(name).id, path, content);
          return text(`Wrote ${content.length} bytes to ${path}`);
        }),
      ),

      tool(
        'sandbox_copy',
        'Copy files between the project and a sandbox. direction "in": project path → sandbox path. direction "out": sandbox path → project ' +
          'path (changes real project files, so it asks the user).',
        { name: z.string(), direction: z.enum(['in', 'out']), from: z.string(), to: z.string() },
        safe(async ({ name, direction, from, to }) => text(await sandboxes.copy(find(name).id, direction, from, to))),
      ),

      tool(
        'sandbox_expose_port',
        'Publish another container port of a sandbox to a free host port. The machine is recreated from a live snapshot: files are kept, running processes restart.',
        { name: z.string(), port: z.number().int() },
        safe(async ({ name, port }) => text(brief(await sandboxes.exposePort(find(name).id, port)))),
      ),

      tool(
        'sandbox_snapshot',
        'Save the full state of a sandbox (files, installed packages) so you can roll back later with sandbox_restore.',
        { name: z.string(), label: z.string().optional() },
        safe(async ({ name, label }) => {
          const s = await sandboxes.snapshot(find(name).id, label);
          return text({ snapshot: s.label, id: s.id, sizeBytes: s.sizeBytes });
        }),
      ),

      tool(
        'sandbox_restore',
        'Roll a sandbox back to a snapshot (by label or id). Processes restart.',
        { name: z.string(), snapshot: z.string() },
        safe(async ({ name, snapshot }) => text(brief(await sandboxes.restore(find(name).id, snapshot)))),
      ),

      tool(
        'sandbox_lifecycle',
        'start / stop / destroy a sandbox, or pin it (never auto-reclaimed) / unpin it. Destroy sandboxes you no longer need.',
        { name: z.string(), action: z.enum(['start', 'stop', 'destroy', 'pin', 'unpin']), keepSnapshots: z.boolean().optional() },
        safe(async ({ name, action, keepSnapshots }) => {
          const sb = find(name);
          if (action === 'destroy') {
            const freed = await sandboxes.destroy(sb.id, { keepSnapshots });
            return text(`Destroyed ${name} (freed ~${Math.round(freed / 1e6)} MB)`);
          }
          if (action === 'pin' || action === 'unpin') return text(brief(sandboxes.update(sb.id, { pinned: action === 'pin' })));
          return text(brief(action === 'start' ? await sandboxes.start(sb.id) : await sandboxes.stop(sb.id)));
        }),
      ),

      tool('sandbox_stats', 'CPU, memory, network, process count and disk usage of a sandbox.', { name: z.string() }, safe(async ({ name }) => text(await sandboxes.stats(find(name).id)))),

      tool(
        'sandbox_shell',
        "Open an interactive root shell into a sandbox in the user's Terminal panel (for when the user wants to poke around themselves).",
        { name: z.string() },
        safe(async ({ name }) => {
          const term = await sandboxes.openShell(find(name).id);
          return text(`Opened "${term.title}" in the project's Terminal panel.`);
        }),
      ),

      tool(
        'storage_report',
        'Disk usage and what the storage cleaner could reclaim right now, by category (sandboxes, snapshots, Docker leftovers, temp files, caches, build artifacts).',
        {},
        safe(async () => {
          const report = cleaner.report();
          const cats = await cleaner.scan();
          return text({
            disk: report.disk,
            lowOnSpace: report.pressure,
            reclaimable: cats.map((c) => ({ category: c.category, label: c.label, bytes: c.bytes, items: c.items.length, autoClean: c.trigger })),
          });
        }),
      ),

      tool(
        'storage_clean',
        'Free disk space now by running the cleaner on the given categories (default: every category whose policy is not "off"). Asks the user.',
        { categories: z.array(z.enum(CATEGORY_ORDER as [string, ...string[]])).optional() },
        safe(async ({ categories }) => {
          const p = cleaner.report().policy;
          const cats = (categories ?? CATEGORY_ORDER.filter((c) => p.categories[c] !== 'off')) as typeof CATEGORY_ORDER;
          const runResult = await cleaner.clean(cats, 'manual');
          return text(runResult ? { freedBytes: runResult.freedBytes, removed: runResult.removed, errors: runResult.errors } : 'Nothing to clean.');
        }),
      ),

      tool(
        'semantic_search',
        'Find code in this project by meaning rather than exact text ("where are refunds calculated?", "retry logic for webhooks"). ' +
          'Returns file ranges ranked by similarity; follow up with Read. Indexing is incremental and automatic.',
        { query: z.string(), k: z.number().int().min(1).max(30).optional(), under: z.string().optional().describe('Only search below this directory') },
        safe(async ({ query, k, under }) => {
          const hits = await semantic.search(project.id, query, k ?? 8, under);
          const model = embeddings.status().active;
          return text({ model: model ? `${model.provider}:${model.model}` : null, hits });
        }),
      ),
    ],
  });
}
