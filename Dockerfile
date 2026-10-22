#
# Cloude — a self-hosted, web-operated Claude Code workbench.
#
# The runtime image is deliberately "batteries included": it is the machine
# Claude works on, so it carries the common toolchains (Node, Python, Go, Rust,
# Java), Docker CLI, a headless browser for testing, and passwordless sudo so
# Claude can apt-get anything else a project needs.

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

# Core OS tooling + build toolchains + things Claude reaches for constantly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client sudo gosu tini \
      build-essential pkg-config make cmake unzip zip xz-utils tar file less nano vim-tiny \
      jq ripgrep fd-find tree htop lsof iproute2 iputils-ping dnsutils procps psmisc \
      sqlite3 postgresql-client default-mysql-client redis-tools \
      python3 python3-pip python3-venv python3-dev pipx \
      openjdk-21-jdk-headless maven \
      bubblewrap socat \
    && rm -rf /var/lib/apt/lists/*

# Node.js + package managers + global CLIs.
# Browsers are installed with the Playwright build that @playwright/mcp pins
# (it tracks alpha releases), into a shared path the agent user can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm yarn bun @anthropic-ai/claude-code @playwright/mcp \
    && PW_CLI=$(node -e "const p=require('path');console.log(require.resolve('playwright/cli.js',{paths:[p.join(process.argv[1],'@playwright/mcp')]}))" "$(npm root -g)") \
    && node "$PW_CLI" install --with-deps chromium \
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
ENV PATH=/home/cloude/.cargo/bin:/home/cloude/.local/bin:$PATH

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
