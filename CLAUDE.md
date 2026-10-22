# Cloude — notes for agents working on this repo

Self-hosted web workbench that runs Claude Code (via `@anthropic-ai/claude-agent-sdk`) on a server and is operated only from the browser. See README.md for the product overview.

## Commands

- `npm run dev -w server` — API on :8787 (tsx watch). `npm run dev -w web` — Vite on :5173, proxies `/api` `/ws` `/preview` `/apps`.
- `npm run typecheck` — both workspaces (TypeScript 7). Run it after every change.
- `npm run build` — web → `web/dist`, server → `server/dist/server/src/index.js`.
- Throwaway local instance: `CLOUDE_DATA_DIR=/tmp/cloude-dev HOST=127.0.0.1 PORT=8799 CLOUDE_ADMIN_PASSWORD=… npx tsx server/src/index.ts`.

## Architecture rules that are easy to break

- `shared/protocol.ts` is the only contract between server and web. Change both sides together.
- **Session id == Claude session id.** First run passes `sessionId`, later runs pass `resume` (gated on `sessions.started`, set when the SDK `init` message arrives). Don't introduce a mapping table.
- The SDK `env` option **replaces** the child environment. Always build it with `buildEnv()` (process env + global secrets + project secrets).
- Every Claude process runs in streaming-input mode fed by `AsyncQueue`. Permission prompts are promises parked in `AgentSession.pending` and resolved by `POST /api/sessions/:id/permissions/:reqId`.
- Outward-facing Cloude MCP tools (`publish`, `deploy`, `open_tunnel`) use `permission_policy: 'always_ask'`. Keep it that way — it's what makes "Full access" mode safe to offer.
- `agent/guard.ts` is a PreToolUse hook and applies in all permission modes, including bypass.
- Preview hosts are untrusted. Never let Cloude cookies reach them (see `stripCloudeCookies`), and keep `isAllowedOrigin` on every state-changing request and WS upgrade.
- Events are persisted (`session_events`) and replayed by seq. Stream deltas and tool progress are live-only (`t: 'live'`).

## Web gotchas

- zustand v5: a selector must not return a fresh array/object (`s.list.filter(...)`) — it loops forever (React error #185). Select the stable value and derive with `useMemo`.
- Panels in the workspace stay mounted once visited (terminals keep their sockets). FilesPanel and TerminalPanel are lazy-loaded; keep CodeMirror/xterm out of the main bundle.
- Design tokens live in `web/src/styles.css` (light "overcast" + dark variant). Server output (terminals, logs, diffs, commands) always renders in `.porthole` insets.

## Workbench extensions (worktrees, board, CLIs, memory, compression, desktop)

- Feature tables use `ensureSchema(name, sql)` from `server/src/schema.ts` (named migrations), not the numbered list in `db.ts`. Parallel branches would collide on numbers.
- Feature settings live in `ext_settings` (`extSettings`, key `workbench`), not `AppSettings`.
- Worktrees live at `<project>/.cloude/worktrees/<id>` on branch `cloude/<id>`. `.cloude/` is excluded via `.git/info/exclude`. Because worktrees sit inside the project, project-relative cwd/safeJoin code works unchanged.
- Files/Git/Terminal routes take a **scope id**: `<projectId>` or `<projectId>~<worktreeId>` (`resolveScope`). The web passes `scopedProject(project, session)` to those panels. Never use `projects.require(req.params.id)` in those routes.
- A worktree session's services are named `<name>@<worktreeId>` and run from the worktree (`createCloudeMcp(project, sessionId, worktree)`).
- Removing a worktree must never lose work: `worktrees.remove` snapshots uncommitted changes, aborts on any git error (`porcelain` throws, no `rmSync` fallback), keeps unmerged branches, stops dev services and terminals inside it, and refuses while a deployment or published folder is served from it. Merge refuses when untracked files exist (they're usually uncommitted new source).
- Claude transcripts are stored per cwd, so a session's resume breaks if its worktree directory disappears. Session-owned worktrees are therefore reset to base after a merge (`resetToBase`), not removed. Merge and remove refuse while the owning session is working.
- Never resolve `${VAR}` in MCP configs server-side: the SDK puts MCP config on Claude's argv, and Claude Code expands `${VAR}` itself from its env (verified). Put stdio-server secrets in `env`, not `args`.
- `config.reservedPorts` (Cloude's port, the desktop VNC port) is enforced by the preview proxy (`portTarget`) and tunnels.
- Modules that react to sessions/terminals subscribe to `bus` (`server/src/bus.ts`) instead of importing each other.
- The `workbench` MCP server's read-only and Cloude-state tools are in `WORKBENCH_AUTO_TOOLS`. `desktop_launch` and `board_start_card` stay out of that list (they run commands / spawn agents).
- Compression is a PostToolUse hook returning `updatedToolOutput`. Anything it drops must stay recoverable (`.cloude/outputs/`).
- The desktop exports `DISPLAY` by setting `process.env.DISPLAY` while running (`buildEnv` copies process env). VNC listens on localhost only and is in `config.reservedPorts`. The browser reaches it only via `/ws/desktop`.
