import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { projects } from '../projects.js';
import { INFRA_AUTO_TOOLS, INFRA_TOOL, createInfraMcp } from './mcp.js';
import { applyRouting, type RoutableRow } from './routing.js';

/**
 * Everything the infra module adds to a Claude process, applied in one call from
 * AgentSession.ensureProcess() right before query(): model/provider routing, the
 * `infra` MCP server (sandboxes, storage, semantic search), a prompt section, and
 * a PreToolUse hook. Keeping it to one call keeps session.ts merge-friendly.
 */
export function applyInfra(options: Options, row: RoutableRow & { project_id: string }) {
  const project = projects.get(row.project_id);
  if (!project) return;

  try {
    applyRouting(options, row, project.id);
  } catch (e) {
    console.error('[infra] routing failed, using the session defaults:', e);
  }

  options.mcpServers = { ...options.mcpServers, infra: createInfraMcp(project, row.id) };
  options.allowedTools = [...(options.allowedTools ?? []), ...INFRA_AUTO_TOOLS];

  const sp = options.systemPrompt;
  if (sp && typeof sp === 'object' && 'type' in sp && sp.type === 'preset') sp.append = `${sp.append ?? ''}\n\n${INFRA_PROMPT}`;

  const pre = options.hooks?.PreToolUse ?? [];
  options.hooks = { ...options.hooks, PreToolUse: [...pre, infraGuard] };
}

/** Stable text (no volatile state) so prompt caching keeps working across turns and resumes. */
const INFRA_PROMPT = [
  '## Sandboxes: machines you fully control',
  '- When a task needs root, system packages, a database or other services, systemd, Docker, another distro, kernel/network settings, or ' +
    'anything destructive or risky, do it in a sandbox (`mcp__infra__sandbox_create` / `sandbox_exec`) instead of on this server.',
  '- A sandbox starts with a private copy of the project at /workspace; its changes do not reach the real files unless you copy them out ' +
    '(asks the user). Install dependencies inside it.',
  '- Publish ports when creating it to test in a browser or with curl via the returned host URL; sandboxes in this project reach each other ' +
    'by name (e.g. postgres://pg:5432). Snapshot before risky steps.',
  '- Destroy sandboxes when the task is done. Idle ones are stopped and reclaimed automatically, so never rely on one surviving a long pause — ' +
    'pin it (`sandbox_lifecycle`) if the user wants it kept.',
  '- `mcp__infra__semantic_search` finds code by meaning; use it to locate where something is implemented in unfamiliar code, then Read.',
  '- If the disk is filling up, check `mcp__infra__storage_report` before deleting anything by hand.',
].join('\n');

/**
 * Sandbox tools are auto-approved, except the two ways a sandbox can reach the real
 * project: a read-write live mount, and copying files out. Those always ask —
 * also under bypassPermissions, because hooks run in every mode.
 */
const infraGuard: HookCallbackMatcher = {
  hooks: [
    async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const args = (input.tool_input ?? {}) as Record<string, unknown>;
      let reason: string | null = null;
      if (input.tool_name === INFRA_TOOL.create && args.mount === 'rw') reason = 'This sandbox would get read-write access to the live project files.';
      if (input.tool_name === INFRA_TOOL.copy && args.direction === 'out') reason = `Copies ${String(args.from)} from the sandbox into the project at ${String(args.to)}.`;
      if (!reason) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
    },
  ],
};
