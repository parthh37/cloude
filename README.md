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
| **Dependencies** | The image ships Node/pnpm/bun, Python/uv, Go, Rust, Java, Docker CLI, gh, mise, and Chromium. Claude has `sudo apt-get` for anything else. |
| **Safety rails** | Publishing, deploying, and tunnels *always* ask, even in full-access mode. A server guard blocks agents from touching Cloude's own database and keys. Previewed apps can never see your Cloude session. |
| **Ops console** | A dark "glass cockpit" UI: an annunciator status bar that lights up when a session needs you, a ⌘K palette to jump anywhere, and a Day theme for sunlight. |
| **Usage** | Spend and tokens booked per turn and model, with charts by day/hour, top sessions and projects, Claude Pro/Max plan-limit meters, and daily/monthly budgets that warn or pause new messages. |
| **Monitor** | Live CPU, memory, disk, network and load for the server, plus how much each group of Cloude processes uses (agents, terminals, every running app). |
| **Secure sign-in** | Authenticator-app 2FA with recovery codes, passkeys (Face ID / Touch ID / security keys), a list of signed-in devices you can sign out remotely, automatic sign-out when idle, lockout after repeated failures, and a security log. |

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

## Security

Cloude gives whoever logs in full control of the server. Treat the admin password like a root password, and turn on two-factor authentication in **Security** right after the first sign-in.

- **Sign-in:** passwords are hashed with scrypt (OWASP parameters, upgraded on the next login). A second step is required once you add an authenticator app or a passkey; recovery codes cover a lost phone. Changing 2FA, passkeys, recovery codes or the password asks for the password again.
- **Sessions:** the login cookie is `HttpOnly`, `SameSite=Lax`, and `__Host-` prefixed over HTTPS. The database stores only a SHA-256 of each token. Logins expire after 30 days, or sooner when idle (7 days by default). Signing a device out also closes its live connections and its app-preview access.
- **Brute force:** failed passwords, codes, and passkeys are counted per IP and per account, and survive restarts. Every sign-in, failure, lockout, and credential change is written to the security log.
- **Headers:** the UI is served with a strict Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`, and HSTS over HTTPS.

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
| `CLOUDE_ADMIN_USER` / `CLOUDE_ADMIN_PASSWORD` | `admin` / generated | First-run login. With `CLOUDE_RESET_ADMIN_PASSWORD=true`, resets a forgotten password on boot and signs out every device |
| `CLOUDE_RESET_ADMIN_2FA` | unset | `true` removes the admin's authenticator, passkeys and recovery codes on boot (last resort if all are lost). Unset it afterwards |
| `CLOUDE_DATA_DIR` | `~/.cloude` | Database, secret key, workspaces |
| `CLOUDE_WORKSPACES_DIR` | `$DATA/workspaces` | Where new projects are created |
| `CLOUDE_CLAUDE_PATH` | bundled | Claude Code executable for sessions |
| `CLOUDE_SECRET` | generated file | Key for cookies and secret encryption |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Listen address |

## Project layout

```
shared/protocol.ts          types shared by server and web (REST + WebSocket contract)
server/src/
  auth.ts, auth/            sign-in sessions, TOTP, passkeys, lockout, security log
  usage.ts                  usage ledger (per-turn deltas), plan limits, budgets
  monitor.ts                server health sampler and per-process breakdown
  agent/session.ts          Agent SDK runtime: sessions, streaming, permissions, resume
  agent/cloude-mcp.ts       MCP tools Claude uses to run, publish and deploy apps
  agent/guard.ts            PreToolUse server-protection hook
  agent/system-prompt.ts    environment briefing appended to Claude Code's prompt
  services/                 process manager, ports, routes, Cloudflare tunnels
  proxy/preview-proxy.ts    host-based preview/app proxy + auth handoff
  terminal/terminals.ts     persistent PTYs
  routes/                   REST API
web/src/
  components/               shell (rail, annunciator, ⌘K palette), HUD panels and charts
  workspace/                chat timeline, tool cards, approvals, files, terminal, apps, git
  pages/                    login, ops, usage, monitor, security, workspace, settings
deploy/                     Caddyfile, entrypoint, install script
```

## License

[MIT](LICENSE)
