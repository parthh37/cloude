import { createSdkMcpServer, tool, type HookCallbackMatcher, type HookEvent, type McpSdkServerConfigWithInstance, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BoardColumn, Project, Worktree } from '../../../shared/protocol.js';
import { board, COLUMNS } from '../board.js';
import { which } from '../config.js';
import { desktop, workbenchSettings } from '../desktop.js';
import { MEMORY_TYPES, memory } from '../memory.js';
import { services } from '../services/service-manager.js';
import { slugify } from '../util/paths.js';
import { worktrees } from '../worktrees.js';
import { compressionHooks } from './compression.js';

/**
 * Everything the workbench extensions add to a Claude session: a system-prompt
 * section, the `workbench` MCP server (memory, board, desktop computer use,
 * worktree status) and the token-compression hook.
 */

export const WORKBENCH_MCP_NAME = 'workbench';
const t = (name: string) => `mcp__${WORKBENCH_MCP_NAME}__${name}`;

/** Tools that only touch Cloude's own state (or just look) — never prompt for these. */
export const WORKBENCH_AUTO_TOOLS = [
  'memory_save',
  'memory_search',
  'memory_get',
  'memory_delete',
  'board_list',
  'board_add_card',
  'board_update_card',
  'worktree_status',
  'desktop_screenshot',
  'desktop_windows',
].map(t);

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  isError,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extra toolchains worth telling Claude about (only the ones actually present). */
function toolchainLine(): string | null {
  const found = [
    ['dotnet', '.NET SDK (`dotnet`)'],
    ['clang', 'clang/LLVM'],
    ['gdb', 'gdb'],
    ['valgrind', 'valgrind'],
    ['ninja', 'ninja'],
    ['gradle', 'gradle'],
    ['kotlin', 'kotlin'],
  ]
    .filter(([bin]) => which(bin!))
    .map(([, label]) => label);
  return found.length ? `- Also installed: ${found.join(', ')}.` : null;
}

export function workbenchPrompt(project: Project, worktree: Worktree | null): string {
  const s = workbenchSettings();
  const lines: string[] = [''];

  if (worktree) {
    lines.push(
      '## Your workspace: an isolated git worktree',
      `You are working in ${worktree.path} on branch \`${worktree.branch}\` (created from \`${worktree.baseBranch}\`). ` +
        'Other sessions work on this project at the same time, each in its own worktree, so:',
      `- Stay inside this directory. Never edit the main checkout (${project.path}) or other worktrees under ${project.path}/.cloude/worktrees/.`,
      '- Dependencies are not shared between worktrees (node_modules, .venv, bin/obj, target): install them here before building or running. ' +
        "Until you do, Node/TypeScript may silently resolve packages from the main checkout's node_modules (a parent directory), which can hide missing or changed dependencies.",
      "- The main checkout's CLAUDE.md is a parent directory, so it is loaded too; where it disagrees with this worktree's files, this branch is the source of truth.",
      '- Never assume a port is free — other sessions run servers too. Use $PORT and start_service (your services are namespaced to this worktree).',
      `- Commit your work on \`${worktree.branch}\` with clear messages. Don't merge into \`${worktree.baseBranch}\`, push, or switch branches: ` +
        'the user reviews and lands your branch from Cloude. If they ask you to resolve conflicts after a sync, fix them here and commit.',
      '',
    );
  }

  const tc = toolchainLine();
  if (tc) lines.push('## More toolchains', tc, '- Playwright test runners (`npx playwright test`) can use the preinstalled browsers.', '');

  if (s.injectMemory) {
    const index = memory.index(project.id);
    lines.push(
      '## Long-term memory',
      'Cloude keeps memory across sessions for this project.' + (index ? ` Index (fetch details with \`${t('memory_get')}\`):` : ' Nothing is saved yet.'),
      ...(index ? [index] : []),
      `- Save durable facts with \`${t('memory_save')}\`: the user's preferences and corrections, decisions and why they were made, ` +
        'non-obvious conventions, pointers to external systems. Do not save what the code or git history already records. Update an existing memory rather than duplicating it.',
      '',
    );
  }

  lines.push(
    '## Board',
    `- The project has a Kanban board. When asked to plan or break down work, create cards with \`${t('board_add_card')}\` — one card per independently ` +
      'mergeable change, with acceptance criteria in the description. Starting a card runs it with its own agent in its own worktree (the user approves).',
  );

  if (desktop.missing().length === 0) {
    lines.push(
      '',
      '## Virtual desktop',
      `- A virtual X11 desktop (${s.desktop.width}×${s.desktop.height}) is available; the user can watch it in the Desktop panel. GUI apps started while it runs appear on it ` +
        `(DISPLAY=${desktop.display}). Launch them with \`${t('desktop_launch')}\` so they run as services with logs.`,
      `- Test desktop apps (Electron, Tauri, Avalonia/.NET, Qt, GTK) like a user would with \`${t('desktop_screenshot')}\`, \`desktop_click\`, \`desktop_type\`, \`desktop_key\`, \`desktop_scroll\`.`,
    );
  }
  return lines.join('\n');
}

function createWorkbenchMcp(project: Project, worktree: Worktree | null): McpSdkServerConfigWithInstance {
  const desktopTools = desktop.missing().length === 0;
  const afterAction = async (shot: boolean | undefined, note: string) => {
    if (shot === false) return text(note);
    await sleep(350);
    return { content: [{ type: 'text' as const, text: note }, { type: 'image' as const, data: await desktop.screenshot(), mimeType: 'image/png' }] };
  };
  const shotArg = z.boolean().optional().describe('Return a screenshot after the action (default true)');

  return createSdkMcpServer({
    name: WORKBENCH_MCP_NAME,
    version: '1.0.0',
    instructions: 'Cloude workbench: long-term memory, the project board, worktree status and the virtual desktop (computer use).',
    tools: [
      // ---- memory ----
      tool(
        'memory_save',
        'Save or update a long-term memory for this project (or for all projects with global=true). One fact per memory; the name is its key.',
        {
          name: z.string().describe('short-kebab-case key, e.g. "deploy-target"'),
          description: z.string().describe('one line that says when this memory is relevant'),
          content: z.string().describe('the fact; for decisions/feedback include why and how to apply it'),
          type: z.enum(MEMORY_TYPES as [string, ...string[]]).optional(),
          global: z.boolean().optional().describe('share with every project (user-level facts)'),
        },
        async (a) => {
          const m = memory.save({ projectId: a.global ? null : project.id, name: a.name, description: a.description, content: a.content, type: a.type as never });
          return text(`Saved memory "${m.name}"`);
        },
      ),
      tool('memory_search', 'Search long-term memories by keywords.', { query: z.string() }, async ({ query }) =>
        text(memory.search(project.id, query).map((m) => ({ name: m.name, type: m.type, description: m.description, content: m.content }))),
      ),
      tool('memory_get', 'Read a memory by name.', { name: z.string() }, async ({ name }) => {
        const m = memory.get(project.id, name);
        return m ? text({ name: m.name, type: m.type, description: m.description, content: m.content, updatedAt: new Date(m.updatedAt).toISOString() }) : text(`No memory named "${name}"`, true);
      }),
      tool('memory_delete', 'Delete a memory that turned out to be wrong or obsolete.', { name: z.string() }, async ({ name }) => {
        const m = memory.get(project.id, name);
        if (!m) return text(`No memory named "${name}"`, true);
        memory.remove(m.id);
        return text(`Deleted "${m.name}"`);
      }),

      // ---- board ----
      tool('board_list', 'List the cards on this project’s Kanban board.', {}, async () =>
        text(
          board.list(project.id).map((c) => ({
            id: c.id,
            title: c.title,
            column: c.column,
            priority: c.priority,
            labels: c.labels,
            agent: c.agent,
            runStatus: c.runStatus,
            description: c.description.slice(0, 400),
          })),
        ),
      ),
      tool(
        'board_add_card',
        'Add a card to the board. Use one card per independently mergeable change; put acceptance criteria in the description.',
        {
          title: z.string(),
          description: z.string().optional(),
          column: z.enum(COLUMNS as [BoardColumn, ...BoardColumn[]]).optional().describe('default "backlog"'),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
          labels: z.array(z.string()).optional(),
          agent: z.string().optional().describe('"claude" (default) or an agent CLI id like "codex", "gemini", "aider"'),
        },
        async (a) => {
          const c = board.create(project.id, a);
          return text({ id: c.id, title: c.title, column: c.column });
        },
      ),
      tool(
        'board_update_card',
        'Update a card (title, description, column, priority, labels).',
        {
          id: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          column: z.enum(COLUMNS as [BoardColumn, ...BoardColumn[]]).optional(),
          priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
          labels: z.array(z.string()).optional(),
        },
        async ({ id, ...patch }) => {
          const c = board.get(id);
          if (c.projectId !== project.id) return text('That card belongs to another project', true);
          const u = board.update(id, patch);
          return text({ id: u.id, title: u.title, column: u.column });
        },
      ),
      tool(
        'board_start_card',
        'Start a card: launches its agent in a new isolated worktree (a separate session). Requires the user to approve.',
        { id: z.string() },
        async ({ id }) => {
          const c = board.get(id);
          if (c.projectId !== project.id) return text('That card belongs to another project', true);
          const started = await board.start(id);
          return text({ id: started.id, sessionId: started.sessionId, terminalId: started.terminalId, worktree: started.worktreeId });
        },
      ),

      // ---- worktree ----
      tool('worktree_status', 'Show this session’s worktree: branch, base, commits ahead/behind, uncommitted files and changed files vs base.', {}, async () => {
        if (!worktree) return text('This session works directly in the main checkout (no worktree).');
        const st = await worktrees.status(project.id, worktree.id);
        return text({ ...st, worktree: { branch: st.worktree.branch, base: st.worktree.baseBranch, path: st.worktree.path } });
      }),

      // ---- desktop (computer use) ----
      ...(desktopTools
        ? [
            tool('desktop_screenshot', 'Screenshot the virtual desktop (starts it if needed). Coordinates in other desktop tools are in this image’s pixels.', {}, async () => ({
              content: [{ type: 'image' as const, data: await desktop.screenshot(), mimeType: 'image/png' }],
            })),
            tool('desktop_windows', 'List the titles of visible windows on the virtual desktop.', {}, async () => text((await desktop.windows()).join('\n') || '(no windows)')),
            tool(
              'desktop_click',
              'Click on the virtual desktop.',
              { x: z.number(), y: z.number(), button: z.enum(['left', 'middle', 'right']).optional(), clicks: z.number().int().min(1).max(3).optional(), screenshot: shotArg },
              async (a) => {
                await desktop.click(a.x, a.y, a.button, a.clicks);
                return afterAction(a.screenshot, `Clicked ${a.button ?? 'left'} at (${a.x}, ${a.y})`);
              },
            ),
            tool('desktop_type', 'Type text into the focused window.', { text: z.string(), screenshot: shotArg }, async (a) => {
              await desktop.type(a.text);
              return afterAction(a.screenshot, `Typed ${a.text.length} characters`);
            }),
            tool(
              'desktop_key',
              'Press keys / shortcuts (xdotool names, space-separated sequence), e.g. "Return", "ctrl+s", "alt+F4", "Tab Tab Return".',
              { keys: z.string(), screenshot: shotArg },
              async (a) => {
                await desktop.key(a.keys);
                return afterAction(a.screenshot, `Pressed ${a.keys}`);
              },
            ),
            tool(
              'desktop_scroll',
              'Scroll at a position.',
              { x: z.number(), y: z.number(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().optional(), screenshot: shotArg },
              async (a) => {
                await desktop.scroll(a.x, a.y, a.direction, a.amount);
                return afterAction(a.screenshot, `Scrolled ${a.direction}`);
              },
            ),
            tool(
              'desktop_drag',
              'Drag with the left button from one point to another.',
              { fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), screenshot: shotArg },
              async (a) => {
                await desktop.drag([a.fromX, a.fromY], [a.toX, a.toY]);
                return afterAction(a.screenshot, 'Dragged');
              },
            ),
            tool(
              'desktop_launch',
              'Start a GUI app on the virtual desktop as a Cloude service (logs visible in Apps), e.g. "npm run electron:dev" or "dotnet run --project src/App".',
              { name: z.string(), command: z.string(), cwd: z.string().optional() },
              async (a) => {
                await desktop.start();
                const name = worktree ? `${slugify(a.name)}@${worktree.id}` : slugify(a.name);
                const cwd = worktree ? `${worktree.relPath}/${a.cwd ?? '.'}` : (a.cwd ?? '.');
                const def = services.upsert({
                  projectId: project.id,
                  name,
                  kind: 'dev',
                  strategy: 'process',
                  command: a.command,
                  cwd,
                  port: null,
                  env: { DISPLAY: desktop.display },
                  autoRestart: false,
                });
                await services.restart(def.id);
                await sleep(3000);
                const logs = services
                  .logs(def.id, -1, 30)
                  .map((l) => l.text)
                  .join('\n');
                return { content: [{ type: 'text' as const, text: `Started ${name}.\n${logs}` }, { type: 'image' as const, data: await desktop.screenshot(), mimeType: 'image/png' }] };
              },
            ),
          ]
        : []),
    ],
  });
}

/** User MCP servers pass through untouched: `${VAR}` is expanded by Claude Code from its env, never by us (keeps secrets out of argv). */
export function workbenchMcpServers(project: Project, worktree: Worktree | null, userServers: Record<string, unknown>): NonNullable<Options['mcpServers']> {
  return {
    [WORKBENCH_MCP_NAME]: createWorkbenchMcp(project, worktree),
    ...(userServers as NonNullable<Options['mcpServers']>),
  };
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** Combine the guard's hooks with the compression hook (each event's matchers are concatenated). */
export function workbenchHooks(base: Hooks, ctx: { sessionId: string; projectId: string; cwd: string }): Hooks {
  const extra: Hooks = compressionHooks({ sessionId: ctx.sessionId, cwd: ctx.cwd, level: () => workbenchSettings().compression });
  const out: Hooks = { ...base };
  for (const [event, matchers] of Object.entries(extra) as [HookEvent, HookCallbackMatcher[]][]) out[event] = [...(out[event] ?? []), ...matchers];
  return out;
}
