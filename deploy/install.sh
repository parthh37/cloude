#!/usr/bin/env bash
# Install Cloude on a fresh Ubuntu/Debian server.
#
#   sudo ./deploy/install.sh                                  # no domain: uses <server-ip>.sslip.io
#   sudo ./deploy/install.sh cloude.example.com you@example.com
#
# - installs Docker if missing
# - opens only SSH/HTTP/HTTPS in the firewall (apps Claude starts listen on the
#   host network, so without a firewall a dev server on :3000 would be public)
# - writes .env with a one-time setup code
# - builds and starts the stack, then prints a link to the setup wizard, where
#   you create your account and connect Claude in the browser
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
if [ -z "$DOMAIN" ]; then
  ip=$(curl -fsS4 https://api.ipify.org || true)
  DOMAIN="${ip}.sslip.io"
  echo "No domain given — using ${DOMAIN} (free wildcard DNS for this server's IP)."
fi
EMAIL="${EMAIL:-admin@${DOMAIN}}"

if ! command -v docker >/dev/null; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null; then
  echo "==> Configuring firewall (22, 80, 443)"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
else
  echo "!! ufw not found — make sure only ports 22/80/443 are reachable from the internet." >&2
fi

if [ ! -f .env ]; then
  cat > .env <<EOF
CLOUDE_DOMAIN=${DOMAIN}
ACME_EMAIL=${EMAIL}
# One-time code for the browser setup wizard. Useless once the account exists.
CLOUDE_SETUP_TOKEN=$(openssl rand -hex 16)
EOF
  chmod 600 .env
fi
# Re-runs go by .env (the domain may have been edited by hand since).
DOMAIN=$(sed -n 's/^CLOUDE_DOMAIN=//p' .env | tail -1)
setup_code=$(sed -n 's/^CLOUDE_SETUP_TOKEN=//p' .env | tail -1)

echo "==> Building and starting Cloude (first build takes a few minutes)"
docker compose up -d --build

echo "==> Waiting for Cloude to start"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break
  sleep 2
done

echo
echo "Make sure DNS has both:  ${DOMAIN}  and  *.${DOMAIN}  ->  this server"
if [ -n "${setup_code}" ] && curl -fsS http://127.0.0.1:8787/api/setup 2>/dev/null | grep -q '"needsAdmin":true'; then
  echo
  echo "Open this link to finish setting up Cloude in your browser:"
  echo
  echo "    https://${DOMAIN}/setup#code=${setup_code}"
  echo
  echo "(The first visit can take a few seconds while the HTTPS certificate is issued.)"
else
  echo "Cloude is running at: https://${DOMAIN}"
fi
