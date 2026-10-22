#!/usr/bin/env bash
# Install Cloude on a fresh Ubuntu/Debian server.
#
#   sudo ./deploy/install.sh cloude.example.com you@example.com
#
# - installs Docker if missing
# - opens only SSH/HTTP/HTTPS in the firewall (apps Claude starts listen on the
#   host network, so without a firewall a dev server on :3000 would be public)
# - writes .env with a generated admin password
# - builds and starts the stack
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
  password=$(openssl rand -base64 18 | tr -d '/+=')
  cat > .env <<EOF
CLOUDE_DOMAIN=${DOMAIN}
CLOUDE_ADMIN_PASSWORD=${password}
ACME_EMAIL=${EMAIL}
EOF
  chmod 600 .env
  created_password=$password
fi

echo "==> Building and starting Cloude (first build takes a few minutes)"
docker compose up -d --build

echo
echo "Cloude is starting at: https://${DOMAIN}"
echo "Make sure DNS has both:  ${DOMAIN}  and  *.${DOMAIN}  ->  this server"
if [ -n "${created_password:-}" ]; then
  echo "Sign in as: admin / ${created_password}   (stored in .env — change it in Settings)"
fi
