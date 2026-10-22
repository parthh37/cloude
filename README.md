# Cloude

**Operate Claude Code on your own server, entirely from a browser.**

Cloude runs Claude Code agents on a server you control and gives you a web workbench to drive them from a laptop or a phone. You can run many sessions side by side, approve risky actions from wherever you are, watch apps run, and publish them to the internet.

```
 browser (phone / laptop)
        │  HTTPS + WebSocket
        ▼
 ┌──────────── Caddy (automatic TLS, *.domain) ────────────┐
 │                                                          │
 │  Cloude server (Node, Fastify)                           │
 │   ├─ Agent runtime ── Claude Agent SDK, one long-lived   │
 │   │                    query() per session               │
 │   │     ├─ canUseTool / AskUserQuestion / plans → browser│
 │   │     ├─ Cloude MCP: services, logs, publish, deploy   │
 │   │     └─ Playwright MCP: headless browser testing      │
 │   ├─ Terminals (PTY over WebSocket, survive disconnects) │
 │   ├─ Files, Git, Secrets, Settings                       │
 │   ├─ Service manager (dev servers + deployments)         │
 │   └─ Preview proxy  p-3000.domain → localhost:3000       │
 │                     myapp.domain  → published route      │
 └──────────────────────────────────────────────────────────┘
```

## What you get

| | |
|---|---|
| **Sessions** | Unlimited concurrent Claude Code sessions per project. They keep running when you close the tab, and reconnecting replays everything you missed. Idle sessions pause to free memory and resume transparently. |
| **Every Claude Code feature** | Built on the official Agent SDK with the full Claude Code preset: all built-in tools, subagents, skills, slash commands, `CLAUDE.md`, `.claude/settings.json`, project `.mcp.json`, plan mode, permission modes, model and effort switching, compaction, file checkpoints (rewind). There's also a one-click **Claude CLI** terminal for anything interactive. |
| **Steer from anywhere** | Tool approvals with diffs, multiple-choice questions, plan review ("approve and auto-edit"), and MCP sign-in forms all appear as cards in the browser, with notifications when Claude needs you. |
| **Build & test** | Web terminal, file editor, Git panel. Claude starts dev servers as *services* (with logs) and verifies UIs itself in a headless browser via Playwright. |
| **Preview** | Every port gets a private, login-protected URL: `https://p-3000.your.domain`. HMR WebSockets work. |
| **Publish & deploy** | Make an app public at `https://myapp.your.domain` or a custom domain. Deploy as a process, a Dockerfile, or a static folder, with auto-restart that survives reboots. Instant `trycloudflare.com` tunnels are also available. |
| **Dependencies** | The image ships Node/pnpm/bun, Python/uv, Go, Rust, Java, .NET 8/9/10, C/C++ (gcc, clang/LLVM, cmake, ninja, gdb, valgrind), Docker CLI, gh, mise, and Chromium + Firefox + WebKit. Claude has `sudo apt-get` for anything else. |
| **Safety rails** | Publishing, deploying, and tunnels *always* ask, even in full-access mode. A server guard blocks agents from touching Cloude's own database and keys. Previewed apps can never see your Cloude session. |
| **Conflict-free parallel work** | Each session can run in its own git worktree and branch. Its services are namespaced, and Files/Git/Terminal follow it there. **Review & land** shows the diff against base, syncs base in (conflicts stay in the worktree for Claude to fix), then merges, squashes, or opens a PR. |
| **Kanban board** | Plan with Claude (it breaks a goal into cards), then run cards in parallel, each with its own agent and worktree. Cards move to Review when the agent finishes and to Done when merged. |
| **Other agent CLIs** | Codex, Gemini, Qwen Code, OpenCode, Copilot, Aider, Cursor, Goose, and local Llama/Qwen through Ollama, plus any CLI you add. Open them in a terminal or assign them to board cards. |
| **Memory & token compression** | Agents save durable facts to project memory. New sessions get only a compact index. Noisy command output (installs, builds, test runs) is compressed before it reaches Claude, typically 80–95% smaller, with the full log kept on disk. |
| **Virtual desktop** | A Linux desktop in the browser (noVNC) for building and testing GUI apps: Electron, Tauri, Avalonia/.NET, Qt, GTK. Claude drives it with screenshot/click/type tools (computer use). |
| **MCP catalog** | One-click MCP servers (GitHub, Context7, Microsoft Learn, Chrome DevTools, databases, Sentry, Notion, Stripe, …). Tokens come from encrypted secrets. |

## Deploy (Docker, recommended)

Requirements: an Ubuntu/Debian VPS (4 GB+ RAM recommended) and a domain with **two DNS records** pointing at it:

```
cloude.example.com     A   203.0.113.7
*.cloude.example.com   A   203.0.113.7
```

No domain? Use `203.0.113.7.sslip.io`. Wildcard DNS works out of the box.

```bash
git clone <this repo> cloude && cd cloude
sudo ./deploy/install.sh cloude.example.com you@example.com
```

The installer sets up Docker, a firewall, and `.env` with a generated admin password, then starts Cloude and Caddy. To do it by hand:

```bash
cp .env.example .env    # set CLOUDE_DOMAIN, CLOUDE_ADMIN_PASSWORD, ACME_EMAIL
docker compose up -d --build
```

Then open `https://cloude.example.com`, sign in, and connect Claude (next section).

### Connect your Claude account

Open **Settings → Claude account** and choose one of these:

- **Claude subscription (Pro/Max):** open any project's **Terminal**, run `claude setup-token`, sign in through the link it prints, and paste the token into Settings.
- **API key:** paste an Anthropic API key.

Credentials are encrypted at rest (AES-256-GCM) and injected into sessions as environment variables.

## Using it

1. **New project:** start empty, clone a Git repo (set a `GH_TOKEN` secret for private repos), or open a folder already on the server.
2. **New session:** ask for anything, e.g. *"Build a todo app with Vite + React, start it, and test adding an item in the browser."*
3. Claude starts the app as a **service**. Open **Apps** to see logs and an inline preview with a phone/desktop toggle.
4. When it's ready, say *"deploy this publicly as todo"*. You'll get an approval card, and after you approve it's live at `https://todo.your.domain`.

Permission modes, set per session from the header pill:

| Mode | Behavior |
|---|---|
| Ask first | Edits and commands ask in the browser |
| Auto-edit | File edits apply, commands still ask |
| Plan | Claude researches and proposes; you approve the plan |
| Auto | A classifier approves routine actions, asks on risky ones |
| Full access | No prompts, *except* publish / deploy / tunnel |

## Parallel work, end to end

1. **Plan:** open **Board → Plan with Claude** and describe a goal. Claude reads the code and adds one card per independently mergeable change, each with acceptance criteria.
2. **Run:** press **Start** on as many cards as you like. Each card gets its own branch `cloude/<card>` in `.cloude/worktrees/<card>` (git-excluded) and its own agent: a Claude session, or Codex, Gemini, Aider, or another CLI running headless. Agents install dependencies and start servers in their own worktree. Ports are allocated per service, so they don't collide.
3. **Review:** when an agent stops, its card moves to **Review**. **Review & land** shows every change against the base, including files the agent never committed.
4. **Land:** **Sync** merges the base into the branch. If that conflicts, the conflict stays in the worktree and **Ask Claude to resolve** hands it back. **Merge** fast-forwards, makes a merge commit, or squashes, and never leaves a half-merged main checkout. **Push & open PR** uses `gh`. The card moves to **Done**. A Claude session keeps its worktree, reset to the new base, so its conversation continues and you can give it the next task. CLI and manual worktrees can be removed on merge. Repo hooks don't block Cloude's merges (`--no-verify`). Merging or removing waits until the agent stops working.

New sessions are isolated by default. Turn off **Isolated worktree** under *New session* to work directly in the main checkout. Removing a worktree never loses work: uncommitted changes are committed to its branch first, and unmerged branches are kept.

## Memory and token compression

- **Memory** (*Board / Memory* in the sidebar) holds facts agents saved with `memory_save`, plus your own entries. Memories are scoped to a project or global. Each session's system prompt carries only the index (name + one line), and details are fetched on demand.
- **Compression** (*Settings → Workbench*) rewrites Bash output before the model sees it. It strips ANSI codes, resolves progress bars, drops noise, and collapses repeats. Very long logs are cut to head + tail + error lines. Whenever lines are dropped, the full output is saved to `.cloude/outputs/<id>.log` and the marker tells Claude where to find it. Levels: off / balanced / aggressive. Each chat header shows the tokens saved.

## Virtual desktop

Open the **Desktop** panel and press *Start*. The server runs `Xvfb` + `fluxbox` + `x11vnc` (VNC bound to localhost only) and streams it through Cloude's authenticated WebSocket, so nothing new is exposed. While it runs, `DISPLAY` is exported to sessions, terminals, and services, so GUI apps appear on it. Claude uses `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_drag`, and `desktop_launch`. Launching an app asks first, because it runs a command. You can watch or take control, and paste your clipboard in.

## Security

Cloude gives whoever logs in full control of the server. Treat the admin password like a root password.

- **Firewall:** apps that Claude starts listen on the host network, so only ports **22, 80, and 443** should be reachable from the internet. `install.sh` configures `ufw` this way. Without a firewall, a dev server on `:3000` would be public, bypassing preview authentication.
- **Preview isolation:** previews run on sibling subdomains and are treated as untrusted. They never receive Cloude's cookies: access uses a signed, host-bound handoff token, and the proxy strips Cloude cookies before forwarding. The API rejects cross-origin writes and WebSocket upgrades. Without a wildcard domain, previews fall back to `/preview/<port>/` on Cloude's own origin. They're served with a CSP `sandbox` there so they can't reach the API, but that also means apps can't use cookies or `localStorage` in path mode.
- **Proxy trust:** `X-Forwarded-*` headers are only honoured from loopback (Caddy), so clients can't spoof their IP past the login rate limit.
- **Agent guard:** a `PreToolUse` hook (active in every permission mode) blocks writes to Cloude's data directory. Add your own command rules in `server/src/agent/guard.ts`.
- **sudo:** enabled in the image so Claude can install system packages. Build with `--build-arg ENABLE_SUDO=false` to turn it off.
- **Docker socket:** mounted so Claude can build and run containers, which is root-equivalent on the host. Remove the mount in `docker-compose.yml` if you don't need Docker deployments.

## Local development

```bash
npm install
npm run dev -w server     # API on :8787 (prints the admin password on first run)
npm run dev -w web        # UI on :5173, proxies /api and /ws to :8787
```

On macOS, your `claude` login lives in the Keychain, which the SDK's bundled binary can't read. Either set `CLOUDE_CLAUDE_PATH=$(which claude)` (after `claude login`), or add a token or API key in Settings.

To try subdomain previews locally (browsers resolve `*.localhost` to loopback):

```bash
CLOUDE_PUBLIC_URL=http://cloude.localhost:8787 CLOUDE_PREVIEW_DOMAIN=cloude.localhost npm run dev -w server
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLOUDE_PUBLIC_URL` | `http://localhost:$PORT` | External URL of the web app |
| `CLOUDE_PREVIEW_DOMAIN` | unset | Wildcard base for `p-<port>.` / `<app>.` hosts. When unset, uses `/preview/<port>/` paths |
| `CLOUDE_ADMIN_USER` / `CLOUDE_ADMIN_PASSWORD` | `admin` / generated | First-run login |
| `CLOUDE_DATA_DIR` | `~/.cloude` | Database, secret key, workspaces |
| `CLOUDE_WORKSPACES_DIR` | `$DATA/workspaces` | Where new projects are created |
| `CLOUDE_CLAUDE_PATH` | bundled | Claude Code executable for sessions |
| `CLOUDE_SECRET` | generated file | Key for cookies and secret encryption |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Listen address |

## Project layout

```
shared/protocol.ts          types shared by server and web (REST + WebSocket contract)
server/src/
  worktrees.ts              per-session git worktrees: create, status, sync, merge/squash, PR, remove
  board.ts                  Kanban cards that run agents and follow their sessions/terminals
  agents/clis.ts            agent CLI registry (presets + custom), install, headless commands
  memory.ts                 long-term memory store + the index injected into prompts
  agent/compression.ts      PostToolUse hook that compresses Bash output for the model
  agent/workbench.ts        workbench MCP tools (memory, board, desktop), prompt section, hooks
  desktop.ts                virtual desktop (Xvfb/x11vnc) + WebSocket bridge + computer-use actions
  mcp-catalog.ts            one-click MCP server presets
  schema.ts                 named, order-independent migrations for feature tables
  agent/session.ts          Agent SDK runtime: sessions, streaming, permissions, resume
  agent/cloude-mcp.ts       MCP tools Claude uses to run, publish and deploy apps
  agent/guard.ts            PreToolUse server-protection hook
  agent/system-prompt.ts    environment briefing appended to Claude Code's prompt
  services/                 process manager, ports, routes, Cloudflare tunnels
  proxy/preview-proxy.ts    host-based preview/app proxy + auth handoff
  terminal/terminals.ts     persistent PTYs
  routes/                   REST API
web/src/
  workspace/                chat timeline, tool cards, approvals, files, terminal, apps, git
  pages/                    login, projects, workspace, settings
deploy/                     Caddyfile, entrypoint, install script
```

## License

[MIT](LICENSE)
