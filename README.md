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
| **Sandboxes** | Disposable machines Claude controls completely (root, any package, databases, systemd, Docker-in-Docker, other distros) for tests that need a real OS. Container isolation by default; gVisor, Sysbox full-OS and Kata microVMs light up when installed. Free host ports, private per-project networks and a private copy of the project, so nothing collides. |
| **Control center** | `/infra`: pick the provider and model for each kind of task (Anthropic, Bedrock, Vertex, Foundry, any Anthropic-compatible gateway, Ollama), manage sandboxes, an automatic storage cleaner that frees space once work is done, and free embeddings that configure themselves for semantic code search. |
| **Preview** | Every port gets a private, login-protected URL: `https://p-3000.your.domain`. HMR WebSockets work. |
| **Publish & deploy** | Make an app public at `https://myapp.your.domain` or a custom domain. Deploy as a process, a Dockerfile, or a static folder, with auto-restart that survives reboots. Instant `trycloudflare.com` tunnels are also available. |
| **Dependencies** | The image ships Node/pnpm/bun, Python/uv, Go, Rust, Java, Docker CLI, gh, mise, and Chromium. Claude has `sudo apt-get` for anything else. |
| **Safety rails** | Publishing, deploying, and tunnels *always* ask, even in full-access mode. A server guard blocks agents from touching Cloude's own database and keys. Previewed apps can never see your Cloude session. |

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

The **control center** (`/infra`, linked from Settings → Server) holds the rest. *Model routing* maps task kinds to a provider and model; start a message with a tag like `#debug` or `#plan` to pick the route, or set it per session there. *Sandboxes* lists every machine Claude created, with a console, root shell, snapshots and preview links. The *Storage* cleaner stops idle sandboxes and reclaims finished ones, old snapshots and leftovers; host-wide Docker pruning and build artifacts are opt-in. *Embeddings* shows the free model that was picked automatically (Ollama if it's running, otherwise a small local model, so your code stays on the server).

Permission modes, set per session from the header pill:

| Mode | Behavior |
|---|---|
| Ask first | Edits and commands ask in the browser |
| Auto-edit | File edits apply, commands still ask |
| Plan | Claude researches and proposes; you approve the plan |
| Auto | A classifier approves routine actions, asks on risky ones |
| Full access | No prompts, *except* publish / deploy / tunnel |

## Security

Cloude gives whoever logs in full control of the server. Treat the admin password like a root password.

- **Firewall:** apps that Claude starts listen on the host network, so only ports **22, 80, and 443** should be reachable from the internet. `install.sh` configures `ufw` this way. Without a firewall, a dev server on `:3000` would be public, bypassing preview authentication.
- **Preview isolation:** previews run on sibling subdomains and are treated as untrusted. They never receive Cloude's cookies: access uses a signed, host-bound handoff token, and the proxy strips Cloude cookies before forwarding. The API rejects cross-origin writes and WebSocket upgrades. Without a wildcard domain, previews fall back to `/preview/<port>/` on Cloude's own origin. They're served with a CSP `sandbox` there so they can't reach the API, but that also means apps can't use cookies or `localStorage` in path mode.
- **Proxy trust:** `X-Forwarded-*` headers are only honoured from loopback (Caddy), so clients can't spoof their IP past the login rate limit.
- **Agent guard:** a `PreToolUse` hook (active in every permission mode) blocks writes to Cloude's data directory. Add your own command rules in `server/src/agent/guard.ts`.
- **Sandboxes & routing:** sandbox tools run without prompts because they act inside disposable containers (never `--privileged`, `no-new-privileges`, CPU/memory/PID limits). The two ways back into the real project, a read-write live mount and copying files out, always ask, even in Full access. When a task routes to a non-Anthropic provider, your Anthropic API key and subscription token are removed from that session's environment.
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
