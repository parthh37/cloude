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
- `server/src/infra/` (sandboxes, storage cleaner, model routing, embeddings) is wired by exactly two calls: `registerInfra(app)` in `index.ts` and `applyInfra(options, row)` in `ensureProcess()`. Add infra behaviour behind those, and tables as named migrations in `infra/store.ts`.
- The cleaner deletes only Docker objects labelled with this install's `cloude.instance` and rebuildable paths; `isProtected()` keeps the data dir, workspaces and projects off-limits. Anything that can reach outside Cloude (host-wide prune, project artifacts, tmp/caches on a dev machine) stays opt-in.
- Routing a session to a non-Anthropic provider must strip `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (`providerEnv()`), so credentials never reach a third-party gateway.
- `agent/guard.ts` is a PreToolUse hook and applies in all permission modes, including bypass.
- Preview hosts are untrusted. Never let Cloude cookies reach them (see `stripCloudeCookies`), and keep `isAllowedOrigin` on every state-changing request and WS upgrade.
- A fresh server is claimed in the browser (`/setup`) with a one-time setup code (`setup.ts`). Never exempt "local" requests from the code: behind Caddy every request arrives from loopback. `claimAdmin` stays synchronous so the "no users yet" check and the INSERT can't interleave.
- Events are persisted (`session_events`) and replayed by seq. Stream deltas and tool progress are live-only (`t: 'live'`).
- Views that watch many sessions (board, dashboard, session list) never subscribe to streams. They read `Session.activity`, a one-line summary built by `agent/activity.ts` and broadcast at most ~1/s per session, and `pending`, which is broadcast on change plus a `pending_all` snapshot on every WS connect. Render them with `components/SessionLive.tsx`.

## Sign-in security

- Auth and Origin checks key off the **matched route** (`req.routeOptions.url`), never `req.url`: the router percent-decodes, so `/%61pi/secrets` reaches `/api/secrets`. Any new pre-routing check on raw URLs must fail closed.
- The cookie holds a random token; `auth_sessions.id` is its SHA-256. Never store or compare raw tokens. The cookie is `__Host-cloude_sid` over HTTPS so preview subdomains can't plant or overwrite it.
- Every WebSocket must be registered with `trackSocket(sid, ws)` — that's how revoking a device (or idle expiry) disconnects it. Preview cookies carry the login `sid` and die with it.
- Any endpoint that checks a secret goes through `auth/throttle.ts` and writes an `audit()` event. Count the attempt **before** any `await` (`beginAttempt`, or `checkPassword` for scrypt) — counting after lets a parallel burst skip the lock. Credential changes (2FA, passkeys, recovery codes, password) call `reauth()` first.
- Second factor is required when TOTP is on **or** any passkey exists. A password login then only gets an in-memory MFA ticket, never a session.
- WebAuthn: rpID is the public hostname, and preview subdomains can request assertions for it — the exact `expectedOrigins()` check is the real guard. Don't loosen it.

## Usage & monitoring

- SDK `modelUsage` is a running total per process (a resumed process may start with the transcript's saved totals; `/clear` resets it). Book usage only through `recordTurn()` (delta vs. `sessions.usage_snapshot`, a drop = counter reset). Never sum `result` messages.
- Budgets and charts are in UTC days/months.
- Live metrics have two watch topics: `metrics` (cheap system sample, the status bar) and `processes` (per-process scan, Monitor page only).

## Web gotchas

- zustand v5: a selector must not return a fresh array/object (`s.list.filter(...)`) — it loops forever (React error #185). Select the stable value and derive with `useMemo`.
- Panels in the workspace stay mounted once visited (terminals keep their sockets). FilesPanel and TerminalPanel are lazy-loaded; keep CodeMirror/xterm out of the main bundle.
- Design tokens live in `web/src/styles.css`: a "glass cockpit" with Night (default) and Day (`[data-theme='day']`). Colours follow the avionics convention — `sky` (cyan) = selected/commanded, `dawn` (magenta) = Claude working, `break` (amber) = needs you, `ok` green, `bad` red. Don't use them decoratively. Server output (terminals, logs, diffs, commands) always renders in `.porthole` insets.
- Global element styles stay inside `@layer base`; unlayered rules beat every Tailwind v4 utility.
- Charts (`components/hud.tsx`) colour models by fixed slot via `modelSlot()` (validated `--series-N` palette), never by rank. Layout grids need `grid-cols-1` so panels can shrink on phones.
- Pages render inside `<Shell>` (rail + annunciator status bar + ⌘K palette); the workspace uses `<Shell bare>`.
