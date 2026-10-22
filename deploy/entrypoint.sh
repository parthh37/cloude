#!/usr/bin/env bash
# Runs as root, fixes up permissions that depend on the host, then drops to the
# unprivileged `cloude` user for the server and everything it spawns.
set -euo pipefail

# Let the cloude user talk to the host's Docker daemon (socket GID varies per host).
if [ -S /var/run/docker.sock ]; then
  gid=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$gid" >/dev/null; then groupadd -g "$gid" docker-host; fi
  usermod -aG "$(getent group "$gid" | cut -d: -f1)" cloude
fi

# Volumes may be created by root on first run.
chown cloude:cloude /data /home/cloude 2>/dev/null || true
mkdir -p /data/workspaces && chown cloude:cloude /data/workspaces

# Seed a minimal git identity so Claude's commits work out of the box (user can change it).
if [ ! -f /home/cloude/.gitconfig ]; then
  gosu cloude git config --global user.name "${GIT_AUTHOR_NAME:-Cloude}"
  gosu cloude git config --global user.email "${GIT_AUTHOR_EMAIL:-cloude@localhost}"
  gosu cloude git config --global init.defaultBranch main
fi

exec gosu cloude "$@"
