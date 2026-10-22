import path from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';

/**
 * Server-protection guard.
 *
 * Runs as a PreToolUse hook, so it applies in EVERY permission mode — including
 * bypassPermissions, where canUseTool is never consulted. It's the last line of
 * defence for the machine Cloude itself runs on (its database, secret key, and
 * the server process), not a general-purpose permission system: day-to-day
 * approvals still happen in the browser.
 */

export type GuardVerdict =
  | { decision: 'deny'; reason: string } // block outright, Claude sees the reason
  | { decision: 'ask'; reason: string } // force a browser prompt even in acceptEdits/bypass
  | { decision: 'defer' }; // no opinion — normal permission flow applies

/** Paths Claude must never write to via file tools. */
function isProtectedPath(p: string): boolean {
  const abs = path.resolve(p);
  const inDataDir = abs === config.dataDir || abs.startsWith(config.dataDir + path.sep);
  const inWorkspaces = abs.startsWith(config.workspacesDir + path.sep); // project files may live under the data dir
  return inDataDir && !inWorkspaces;
}

/**
 * Classify a shell command Claude wants to run on the server.
 *
 * Context you have available:
 *   - `command`: the full Bash string, e.g. "rm -rf node_modules && npm ci"
 *   - `config.dataDir`: Cloude's own state (cloude.db, secret.key) — destroying it
 *     wipes every session and secret
 *   - `config.port`: the port the Cloude server listens on
 *
 * Return 'deny' for things that would take down the host or Cloude itself,
 * 'ask' for things that are legitimate but risky enough to want a human
 * (even when the session runs with bypassPermissions), and 'defer' otherwise.
 */
export function classifyBashCommand(command: string): GuardVerdict {
  // TODO(you): decide what's catastrophic vs. risky on YOUR server (5-10 lines).
  void command;
  return { decision: 'defer' };
}

export function guardHooks(): Partial<Record<'PreToolUse', HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
            let verdict: GuardVerdict = { decision: 'defer' };

            if (input.tool_name === 'Bash' && typeof toolInput.command === 'string') {
              verdict = classifyBashCommand(toolInput.command);
            } else if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
              const target = (toolInput.file_path ?? toolInput.notebook_path) as string | undefined;
              if (target && isProtectedPath(target)) {
                verdict = { decision: 'deny', reason: `${target} belongs to the Cloude control plane and is read-only for agents.` };
              }
            }

            if (verdict.decision === 'defer') return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: verdict.decision,
                permissionDecisionReason: verdict.reason,
              },
            };
          },
        ],
      },
    ],
  };
}
