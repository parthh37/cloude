#
# Cloude — a self-hosted, web-operated Claude Code workbench.
#
# The runtime image is deliberately "batteries included": it is the machine
# Claude works on, so it carries the common toolchains (Node, Python, Go, Rust,
# Java, .NET, C/C++), Docker CLI, every Playwright browser for testing, a
# virtual desktop for GUI apps, other agent CLIs, and passwordless sudo so
# Claude can apt-get anything else a project needs.
#
# Trim it with build args, e.g.
#   docker compose build --build-arg DOTNET_CHANNELS="8.0" --build-arg PLAYWRIGHT_BROWSERS=chromium --build-arg AGENT_CLIS=

# ---------------------------------------------------------------- build stage
FROM node:24-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev --foreground-scripts
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server
# Production-only dependencies for the server.
RUN rm -rf node_modules && npm ci --omit=dev --workspace server --include-workspace-root=false

# -------------------------------------------------------------- runtime stage
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG GO_VERSION=1.26.0
ARG ENABLE_SUDO=true
# .NET SDK channels installed side by side (LTS + STS); `global.json` picks per project.
ARG DOTNET_CHANNELS="8.0 9.0 10.0"
# Playwright engines for `npx playwright test` and the Playwright MCP server.
ARG PLAYWRIGHT_BROWSERS="chromium firefox webkit"
# Other coding-agent CLIs (npm packages). Aider, Ollama, Goose and Cursor install on demand from Settings → Agent CLIs.
ARG AGENT_CLIS="@openai/codex @google/gemini-cli @qwen-code/qwen-code opencode-ai"

# Core OS tooling + build toolchains + things Claude reaches for constantly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client sudo gosu tini \
      build-essential pkg-config make cmake unzip zip xz-utils tar file less nano vim-tiny \
      jq ripgrep fd-find tree htop lsof iproute2 iputils-ping dnsutils procps psmisc \
      sqlite3 postgresql-client default-mysql-client redis-tools \
      python3 python3-pip python3-venv python3-dev pipx \
      openjdk-21-jdk-headless maven \
      bubblewrap socat \
      # C / C++: LLVM toolchain, debuggers, profilers, faster builds
      clang clangd clang-format clang-tidy lld lldb gdb valgrind ninja-build ccache meson \
      # linters and media tools test suites lean on
      shellcheck ffmpeg imagemagick \
      # .NET runtime dependencies
      libicu74 libssl3 zlib1g \
      # virtual desktop: X server, VNC bridge, input automation, a window manager, fonts
      # (hsetroot: fluxbox's wallpaper fallback, ImageMagick `display`, exits 1 and pops up an error)
      xvfb x11vnc xdotool x11-utils xauth dbus-x11 fluxbox hsetroot \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# .NET SDKs (official install script, one directory, every channel side by side).
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && for ch in $DOTNET_CHANNELS; do bash /tmp/dotnet-install.sh --channel "$ch" --install-dir "$DOTNET_ROOT" --no-path; done \
    && ln -sf "$DOTNET_ROOT/dotnet" /usr/local/bin/dotnet \
    && rm /tmp/dotnet-install.sh \
    && dotnet --list-sdks

# Node.js + package managers + global CLIs.
# Browsers are installed with the Playwright build that @playwright/mcp pins
# (it tracks alpha releases), into a shared path the agent user can read.
# playwright's "exports" doesn't list cli.js, so locate it via package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm yarn bun typescript tsx @anthropic-ai/claude-code @playwright/mcp $AGENT_CLIS \
    && PW_CLI=$(node -e "const p=require('path');console.log(p.join(p.dirname(require.resolve('playwright/package.json',{paths:[p.join(process.argv[1],'@playwright/mcp')]})),'cli.js'))" "$(npm root -g)") \
    && node "$PW_CLI" install --with-deps $PLAYWRIGHT_BROWSERS \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /root/.npm /root/.cache

# Go
RUN arch=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH

# Docker CLI + compose plugin (talks to the host daemon via the mounted socket)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/github.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/github.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin gh \
    && rm -rf /var/lib/apt/lists/*

# cloudflared (instant public URLs), uv (Python), mise (any language version on demand)
RUN arch=$(dpkg --print-architecture) \
    && curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
    && chmod +x /usr/local/bin/cloudflared \
    && curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# The agent's user. Rust is installed per-user so `cargo install` works without root.
RUN useradd -m -s /bin/bash -u 1001 cloude \
    && if [ "$ENABLE_SUDO" = "true" ]; then echo "cloude ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/cloude && chmod 0440 /etc/sudoers.d/cloude; fi \
    && mkdir -p /data /ms-playwright && chown -R cloude:cloude /data
USER cloude
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && echo 'eval "$(mise activate bash)"' >> /home/cloude/.bashrc
USER root
ENV PATH=/home/cloude/.cargo/bin:/home/cloude/.local/bin:/home/cloude/.dotnet/tools:$PATH
# Global npm installs made at runtime (Settings → Agent CLIs, or Claude) go to the
# agent's home: no root needed, and they survive image rebuilds in the cloude-home volume.
ENV NPM_CONFIG_PREFIX=/home/cloude/.local

WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web/dist
COPY deploy/entrypoint.sh /usr/local/bin/cloude-entrypoint
RUN chmod +x /usr/local/bin/cloude-entrypoint

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8787 \
    CLOUDE_DATA_DIR=/data \
    CLOUDE_WEB_DIST=/app/web/dist \
    SHELL=/bin/bash \
    HOME=/home/cloude

VOLUME ["/data", "/home/cloude"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "cloude-entrypoint"]
CMD ["node", "/app/server/dist/server/src/index.js"]
