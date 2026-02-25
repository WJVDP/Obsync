#!/usr/bin/env sh
set -eu

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Missing Docker Compose plugin (docker compose)." >&2
  exit 1
fi

REPO_URL="${OBSYNC_REPO_URL:-https://github.com/WJVDP/Obsync.git}"
REF="${OBSYNC_REF:-main}"
INSTALL_DIR="${OBSYNC_INSTALL_DIR:-$HOME/obsync}"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$REF" --depth 1
  git -C "$INSTALL_DIR" checkout "$REF"
  git -C "$INSTALL_DIR" pull --ff-only origin "$REF"
else
  echo "Cloning Obsync to $INSTALL_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
[ -f .env ] || cp .env.example .env

echo "Starting Obsync stack via docker compose..."
docker compose up -d --build

echo "Done."
echo "Next: BOOTSTRAP_EMAIL=user@example.com BOOTSTRAP_PASSWORD='change-this-password' npm run -w @obsync/server bootstrap:user"
