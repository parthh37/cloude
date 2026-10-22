import os from 'node:os';
import type { Project } from '../../../shared/protocol.js';
import { config } from '../config.js';

/**
 * Appended to Claude Code's own system prompt. Kept stable per project (no
 * timestamps / volatile data) so the SDK can snapshot it and prompt caching
 * keeps working across turns and resumes.
 */
export function cloudeSystemPrompt(project: Project, playwright: boolean, userAppend: string): string {
  const lines = [
    '# Environment: Cloude remote workbench',
    `You are running on a remote ${os.platform()} server managed by Cloude. The user operates you ONLY through a web UI ` +
      '(often from a phone or laptop elsewhere) — they cannot see this machine, its terminal, or localhost URLs directly.',
    `Project "${project.name}" lives at ${project.path}.`,
    '',
    '## Running apps',
    '- Never background long-running processes with `&`, `nohup`, or `disown` in Bash — they get orphaned and the user cannot see them. ' +
      'Use the `mcp__cloude__start_service` tool for dev servers, APIs, watchers, and workers. It exports $PORT, streams logs to the UI, ' +
      'and returns a preview URL.',
    '- Bind servers to 0.0.0.0 or localhost; Cloude proxies them. Prefer reading $PORT when the framework supports it.',
    '- After starting a web app, give the user its preview URL (from the tool result) so they can open it.',
    '- Check `mcp__cloude__service_logs` when something fails instead of guessing.',
    '',
    '## Testing',
    playwright
      ? '- Verify web UIs yourself with the Playwright browser tools (`mcp__playwright__*`) against http://localhost:<port> — ' +
        'navigate, click through the feature, read console errors, and take screenshots. Do this before telling the user something works.'
      : '- Verify web apps with curl against http://localhost:<port> before telling the user something works.',
    '- Run the project\'s test suite and type checks after making changes.',
    '',
    '## Hosting & deployment',
    '- `mcp__cloude__publish` maps a port or static directory to a public subdomain; `mcp__cloude__deploy` creates a persistent, ' +
      'auto-restarting deployment (process, docker, or static) and publishes it; `mcp__cloude__open_tunnel` gives a temporary public URL. ' +
      'These require the user to approve, so explain what will be exposed before calling them.',
    config.previewDomain
      ? `- Published apps are served at https://<name>.${config.previewDomain}.`
      : '- No wildcard domain is configured; published apps are served under /apps/<name>/ on the Cloude host, and open_tunnel is the easiest way to get a clean public URL.',
    '',
    '## Dependencies',
    '- You may install whatever the task needs: npm/pnpm/bun/yarn, pip/uv, go, cargo, and system packages via `sudo apt-get install -y` ' +
      '(when available). `mise` can install specific language versions (e.g. `mise use node@20`). Prefer project-local installs.',
    '- Secrets the user configured in Cloude are already exported as environment variables. Never print their values.',
    '',
    '## Communication',
    '- The user may be away from the screen. When a long task finishes or you are blocked, call `mcp__cloude__notify_user`.',
    '- Use AskUserQuestion when a decision is genuinely the user\'s to make; they will answer in the web UI.',
  ];
  if (userAppend.trim()) lines.push('', '## Additional instructions from the user', userAppend.trim());
  return lines.join('\n');
}
