#!/usr/bin/env sh
set -eu

REPO_URL="${OBSYNC_REPO_URL:-https://github.com/WJVDP/Obsync.git}"
REF="${OBSYNC_REF:-main}"
INSTALL_DIR="${OBSYNC_INSTALL_DIR:-$HOME/obsync}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ask_input() {
  prompt="$1"
  default_value="${2:-}"
  if [ -n "$default_value" ]; then
    printf "%s [%s]: " "$prompt" "$default_value" >&2
  else
    printf "%s: " "$prompt" >&2
  fi
  IFS= read -r value || value=""
  if [ -z "$value" ]; then
    value="$default_value"
  fi
  printf "%s" "$value"
}

ask_yes_no() {
  prompt="$1"
  default_choice="$2"
  while true; do
    if [ "$default_choice" = "Y" ]; then
      printf "%s [Y/n]: " "$prompt"
    else
      printf "%s [y/N]: " "$prompt"
    fi
    IFS= read -r answer || answer=""
    case "$answer" in
      "") answer="$default_choice" ;;
      y|Y|yes|YES|Yes) answer="Y" ;;
      n|N|no|NO|No) answer="N" ;;
      *) echo "Please answer y or n." ; continue ;;
    esac
    if [ "$answer" = "Y" ]; then
      return 0
    fi
    return 1
  done
}

json_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

wait_for_health() {
  base_url="$1"
  tries=0
  while [ "$tries" -lt 60 ]; do
    if curl -fsS "$base_url/v1/admin/health" >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

ensure_repo_checkout() {
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  repo_root="$(dirname "$script_dir")"
  if [ -f "$repo_root/docker-compose.yml" ] && [ -f "$repo_root/scripts/install-plugin.sh" ]; then
    REPO_ROOT="$repo_root"
    return 0
  fi

  require_cmd git
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating existing checkout in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin "$REF" --depth 1
    git -C "$INSTALL_DIR" checkout "$REF"
    git -C "$INSTALL_DIR" pull --ff-only origin "$REF"
  else
    echo "Cloning Obsync to $INSTALL_DIR"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  fi

  REPO_ROOT="$INSTALL_DIR"
}

REPO_ROOT=""
ensure_repo_checkout
cd "$REPO_ROOT"

echo "Obsync interactive installer"
echo "Repository: $REPO_ROOT"
echo

BASE_URL="http://localhost:8080"
VAULT_ID=""
BOOTSTRAP_EMAIL=""
BOOTSTRAP_PASSWORD=""

if ask_yes_no "Set up server stack now?" "Y"; then
  require_cmd docker
  require_cmd curl

  if ! docker compose version >/dev/null 2>&1; then
    echo "Missing Docker Compose plugin (docker compose)." >&2
    exit 1
  fi

  [ -f .env ] || cp .env.example .env

  echo "Starting containers (this can take a few minutes on first run)..."
  docker compose up -d --build

  BASE_URL="$(ask_input "Server base URL" "http://localhost:8080")"
  echo "Waiting for server health check at $BASE_URL ..."
  if wait_for_health "$BASE_URL"; then
    echo "Server is healthy."
  else
    echo "Server did not become healthy in time. Check: docker compose logs server" >&2
    exit 1
  fi

  if ask_yes_no "Create first user and vault now?" "Y"; then
    BOOTSTRAP_EMAIL="$(ask_input "Bootstrap email" "user@example.com")"
    BOOTSTRAP_PASSWORD="$(ask_input "Bootstrap password (min 12 chars)" "change-this-password")"
    VAULT_NAME="$(ask_input "Initial vault name" "Personal Vault")"

    if BOOTSTRAP_EMAIL="$BOOTSTRAP_EMAIL" BOOTSTRAP_PASSWORD="$BOOTSTRAP_PASSWORD" docker compose exec -T server npm run -w @obsync/server bootstrap:user >/tmp/obsync-bootstrap-user.log 2>&1; then
      echo "Bootstrap user created."
    else
      echo "Bootstrap step skipped/failed (user may already exist). Continuing..." >&2
    fi

    EMAIL_JSON="$(json_escape "$BOOTSTRAP_EMAIL")"
    PASSWORD_JSON="$(json_escape "$BOOTSTRAP_PASSWORD")"
    LOGIN_RESPONSE="$(curl -sS "$BASE_URL/v1/auth/login" -H "content-type: application/json" -d "{\"email\":\"$EMAIL_JSON\",\"password\":\"$PASSWORD_JSON\"}" || true)"
    TOKEN="$(printf "%s" "$LOGIN_RESPONSE" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

    if [ -n "$TOKEN" ]; then
      VAULT_JSON="$(json_escape "$VAULT_NAME")"
      VAULT_RESPONSE="$(curl -sS "$BASE_URL/v1/vaults" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"name\":\"$VAULT_JSON\"}" || true)"
      VAULT_ID="$(printf "%s" "$VAULT_RESPONSE" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [ -n "$VAULT_ID" ]; then
        echo "Created vault: $VAULT_ID"
      else
        echo "Could not auto-create vault. You can create one later via API." >&2
      fi
    else
      echo "Could not log in with provided credentials. You can log in/create vault later." >&2
    fi
  fi
fi

if ask_yes_no "Install Obsync plugin into a local Obsidian vault on this machine?" "N"; then
  VAULT_PATH="$(ask_input "Absolute vault path" "")"
  if [ -z "$VAULT_PATH" ]; then
    echo "Vault path is required for plugin install." >&2
    exit 1
  fi
  sh "$REPO_ROOT/scripts/install-plugin.sh" "$VAULT_PATH"
fi

echo
echo "Install complete."
echo "Repository: $REPO_ROOT"
echo "Server URL: $BASE_URL"
if [ -n "$VAULT_ID" ]; then
  echo "Vault ID: $VAULT_ID"
fi
if [ -n "$BOOTSTRAP_EMAIL" ]; then
  echo "Bootstrap user: $BOOTSTRAP_EMAIL"
fi
