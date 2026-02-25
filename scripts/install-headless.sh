#!/usr/bin/env sh
set -eu

REPO_URL="${OBSYNC_REPO_URL:-https://github.com/WJVDP/Obsync.git}"
REF="${OBSYNC_REF:-main}"
INSTALL_DIR="${OBSYNC_INSTALL_DIR:-$HOME/obsync}"

TMP_FILES=""

register_tmp_file() {
  TMP_FILES="${TMP_FILES} $1"
}

cleanup() {
  for file in $TMP_FILES; do
    if [ -n "$file" ] && [ -f "$file" ]; then
      rm -f "$file"
    fi
  done
}

trap cleanup EXIT INT TERM

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

ask_secret() {
  prompt="$1"
  printf "%s: " "$prompt" >&2
  if [ -t 0 ] && [ -t 1 ] && command -v stty >/dev/null 2>&1; then
    stty -echo
    IFS= read -r value || value=""
    stty echo
    printf "\n" >&2
  else
    IFS= read -r value || value=""
  fi
  printf "%s" "$value"
}

ask_yes_no() {
  prompt="$1"
  default_choice="$2"
  while true; do
    if [ "$default_choice" = "Y" ]; then
      printf "%s [Y/n]: " "$prompt" >&2
    else
      printf "%s [y/N]: " "$prompt" >&2
    fi
    IFS= read -r answer || answer=""
    case "$answer" in
      "") answer="$default_choice" ;;
      y|Y|yes|YES|Yes) answer="Y" ;;
      n|N|no|NO|No) answer="N" ;;
      *) echo "Please answer y or n." >&2 ; continue ;;
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

extract_json_string() {
  key="$1"
  payload="$2"
  printf "%s" "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

strip_wrapping_quotes() {
  value="$1"
  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac
  printf "%s" "$value"
}

read_env_var() {
  env_file="$1"
  key="$2"
  if [ ! -f "$env_file" ]; then
    return 0
  fi
  raw="$(awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1) } END { print value }' "$env_file")"
  strip_wrapping_quotes "$raw"
}

upsert_env_var() {
  env_file="$1"
  key="$2"
  value="$3"
  temp_file="$(mktemp)"
  register_tmp_file "$temp_file"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "$env_file" > "$temp_file"
  mv "$temp_file" "$env_file"
}

mask_secret() {
  secret="$1"
  length="$(printf "%s" "$secret" | awk '{ print length }')"
  if [ "$length" -le 10 ]; then
    printf "****"
    return 0
  fi

  prefix="$(printf "%s" "$secret" | sed -n 's/^\(......\).*/\1/p')"
  suffix="$(printf "%s" "$secret" | sed -n 's/.*\(....\)$/\1/p')"
  printf "%s...%s" "$prefix" "$suffix"
}

ensure_repo_checkout() {
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  repo_root="$(dirname "$script_dir")"
  if [ -f "$repo_root/docker-compose.yml" ] && [ -f "$repo_root/scripts/install.sh" ]; then
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

require_cmd curl
require_cmd docker
require_cmd sed
require_cmd mktemp

REPO_ROOT=""
ensure_repo_checkout
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env"
[ -f "$ENV_FILE" ] || cp "$REPO_ROOT/.env.example" "$ENV_FILE"

echo "Obsync headless installer"
echo "Repository: $REPO_ROOT"
echo

default_base_url="$(read_env_var "$ENV_FILE" "HEADLESS_BASE_URL")"
if [ -z "$default_base_url" ]; then
  default_base_url="${OBSYNC_HEADLESS_BASE_URL:-http://localhost:8080}"
fi
default_sync_base_url="$(read_env_var "$ENV_FILE" "HEADLESS_SYNC_BASE_URL")"
default_vault_id="$(read_env_var "$ENV_FILE" "HEADLESS_VAULT_ID")"
default_mirror_path="$(read_env_var "$ENV_FILE" "HEADLESS_MIRROR_PATH")"
default_seed_source_path="$(read_env_var "$ENV_FILE" "HEADLESS_SEED_SOURCE_PATH")"
default_seed_enabled="$(read_env_var "$ENV_FILE" "HEADLESS_SEED_SOURCE_ENABLED")"
default_push_local="$(read_env_var "$ENV_FILE" "HEADLESS_PUSH_LOCAL_CHANGES")"
if [ -z "$default_mirror_path" ]; then
  default_mirror_path="/srv/obsync/vault-mirror"
fi
if [ "$default_seed_enabled" != "1" ]; then
  default_seed_source_path=""
fi
if [ "$default_push_local" != "0" ]; then
  default_push_local="1"
fi

BASE_URL="$(ask_input "Server base URL" "$default_base_url")"
SYNC_BASE_URL="$default_sync_base_url"
if [ -z "$SYNC_BASE_URL" ]; then
  case "$BASE_URL" in
    http://localhost:*|https://localhost:*|http://127.0.0.1:*|https://127.0.0.1:*)
      SYNC_BASE_URL="http://server:8080"
      ;;
    *)
      SYNC_BASE_URL="$BASE_URL"
      ;;
  esac
fi
EMAIL="$(ask_input "Account email" "${OBSYNC_HEADLESS_EMAIL:-user@example.com}")"
PASSWORD="$(ask_secret "Account password")"
if [ -z "$PASSWORD" ]; then
  echo "Password is required." >&2
  exit 1
fi
VAULT_ID="$(ask_input "Vault ID (leave empty to create a vault)" "$default_vault_id")"
VAULT_NAME=""
if [ -z "$VAULT_ID" ]; then
  VAULT_NAME="$(ask_input "Vault name (used when creating vault)" "Personal Vault")"
fi
MIRROR_PATH="$(ask_input "Mirror path on host" "$default_mirror_path")"
SEED_SOURCE_PATH="$(ask_input "Initial full-seed source path on this host (optional)" "$default_seed_source_path")"
HEADLESS_SEED_SOURCE_ENABLED="0"
if [ -n "$SEED_SOURCE_PATH" ]; then
  if [ ! -d "$SEED_SOURCE_PATH" ]; then
    echo "Seed source path not found: $SEED_SOURCE_PATH" >&2
    exit 1
  fi
  HEADLESS_SEED_SOURCE_ENABLED="1"
fi
HEADLESS_PUSH_LOCAL_CHANGES="$default_push_local"
if ask_yes_no "Push local markdown edits from mirror back to vault (bidirectional mode)?" "Y"; then
  HEADLESS_PUSH_LOCAL_CHANGES="1"
else
  HEADLESS_PUSH_LOCAL_CHANGES="0"
fi

EMAIL_JSON="$(json_escape "$EMAIL")"
PASSWORD_JSON="$(json_escape "$PASSWORD")"

login_response_file="$(mktemp)"
register_tmp_file "$login_response_file"
login_status="$(curl -sS -o "$login_response_file" -w "%{http_code}" "$BASE_URL/v1/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL_JSON\",\"password\":\"$PASSWORD_JSON\"}")"
login_body="$(cat "$login_response_file")"
if [ "$login_status" -lt 200 ] || [ "$login_status" -ge 300 ]; then
  login_error="$(extract_json_string "message" "$login_body")"
  if [ -z "$login_error" ]; then
    login_error="$login_body"
  fi
  echo "Login failed ($login_status): $login_error" >&2
  exit 1
fi

JWT="$(extract_json_string "token" "$login_body")"
if [ -z "$JWT" ]; then
  echo "Login response missing token." >&2
  exit 1
fi

if [ -z "$VAULT_ID" ]; then
  VAULT_NAME_JSON="$(json_escape "$VAULT_NAME")"
  vault_response_file="$(mktemp)"
  register_tmp_file "$vault_response_file"
  vault_status="$(curl -sS -o "$vault_response_file" -w "%{http_code}" "$BASE_URL/v1/vaults" \
    -H "authorization: Bearer $JWT" \
    -H "content-type: application/json" \
    -d "{\"name\":\"$VAULT_NAME_JSON\"}")"
  vault_body="$(cat "$vault_response_file")"
  if [ "$vault_status" -lt 200 ] || [ "$vault_status" -ge 300 ]; then
    vault_error="$(extract_json_string "message" "$vault_body")"
    if [ -z "$vault_error" ]; then
      vault_error="$vault_body"
    fi
    echo "Vault creation failed ($vault_status): $vault_error" >&2
    exit 1
  fi
  VAULT_ID="$(extract_json_string "id" "$vault_body")"
  if [ -z "$VAULT_ID" ]; then
    echo "Vault creation response missing id." >&2
    exit 1
  fi
  echo "Created vault: $VAULT_ID"
fi

existing_api_token="$(read_env_var "$ENV_FILE" "HEADLESS_API_TOKEN")"
HEADLESS_API_TOKEN="$existing_api_token"
should_rotate_token=1
if [ -n "$existing_api_token" ]; then
  if ask_yes_no "Existing HEADLESS_API_TOKEN found. Keep existing token?" "Y"; then
    should_rotate_token=0
  fi
fi

if [ "$should_rotate_token" -eq 1 ]; then
  hostname_value="$(hostname 2>/dev/null || uname -n || echo "unknown-host")"
  safe_hostname="$(printf "%s" "$hostname_value" | sed 's/[^A-Za-z0-9._-]/-/g')"
  key_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  key_name="headless-sync-$safe_hostname-$key_timestamp"
  key_name_json="$(json_escape "$key_name")"

  apikey_response_file="$(mktemp)"
  register_tmp_file "$apikey_response_file"
  apikey_status="$(curl -sS -o "$apikey_response_file" -w "%{http_code}" "$BASE_URL/v1/apikeys" \
    -H "authorization: Bearer $JWT" \
    -H "content-type: application/json" \
    -d "{\"name\":\"$key_name_json\",\"scopes\":[\"read\",\"write\"]}")"
  apikey_body="$(cat "$apikey_response_file")"
  if [ "$apikey_status" -lt 200 ] || [ "$apikey_status" -ge 300 ]; then
    apikey_error="$(extract_json_string "message" "$apikey_body")"
    if [ -z "$apikey_error" ]; then
      apikey_error="$apikey_body"
    fi
    echo "API key creation failed ($apikey_status): $apikey_error" >&2
    exit 1
  fi

  HEADLESS_API_TOKEN="$(extract_json_string "apiKey" "$apikey_body")"
  if [ -z "$HEADLESS_API_TOKEN" ]; then
    echo "API key response missing apiKey." >&2
    exit 1
  fi
fi

if [ -z "$HEADLESS_API_TOKEN" ]; then
  echo "No API key available to persist." >&2
  exit 1
fi

if [ "$HEADLESS_SEED_SOURCE_ENABLED" = "1" ]; then
  require_cmd rsync
  if ask_yes_no "Run initial full-seed copy now? (rsync --delete, excludes .obsidian)" "Y"; then
    mkdir -p "$MIRROR_PATH"
    rsync -a --delete --exclude ".obsidian/" "$SEED_SOURCE_PATH/" "$MIRROR_PATH/"
    echo "Initial mirror seed completed."
  fi
fi

working_env_file="$(mktemp)"
register_tmp_file "$working_env_file"
cp "$ENV_FILE" "$working_env_file"
upsert_env_var "$working_env_file" "HEADLESS_BASE_URL" "$BASE_URL"
upsert_env_var "$working_env_file" "HEADLESS_SYNC_BASE_URL" "$SYNC_BASE_URL"
upsert_env_var "$working_env_file" "HEADLESS_VAULT_ID" "$VAULT_ID"
upsert_env_var "$working_env_file" "HEADLESS_API_TOKEN" "$HEADLESS_API_TOKEN"
upsert_env_var "$working_env_file" "HEADLESS_MIRROR_PATH" "$MIRROR_PATH"
upsert_env_var "$working_env_file" "HEADLESS_PUSH_LOCAL_CHANGES" "$HEADLESS_PUSH_LOCAL_CHANGES"
upsert_env_var "$working_env_file" "HEADLESS_SEED_SOURCE_ENABLED" "$HEADLESS_SEED_SOURCE_ENABLED"
upsert_env_var "$working_env_file" "HEADLESS_SEED_SOURCE_PATH" "$SEED_SOURCE_PATH"
mv "$working_env_file" "$ENV_FILE"

echo
echo "Headless configuration saved to $ENV_FILE"
echo "  HEADLESS_BASE_URL=$BASE_URL"
echo "  HEADLESS_SYNC_BASE_URL=$SYNC_BASE_URL"
echo "  HEADLESS_VAULT_ID=$VAULT_ID"
echo "  HEADLESS_MIRROR_PATH=$MIRROR_PATH"
echo "  HEADLESS_PUSH_LOCAL_CHANGES=$HEADLESS_PUSH_LOCAL_CHANGES"
echo "  HEADLESS_SEED_SOURCE_ENABLED=$HEADLESS_SEED_SOURCE_ENABLED"
if [ "$HEADLESS_SEED_SOURCE_ENABLED" = "1" ]; then
  echo "  HEADLESS_SEED_SOURCE_PATH=$SEED_SOURCE_PATH"
fi
echo "  HEADLESS_API_TOKEN=$(mask_secret "$HEADLESS_API_TOKEN")"

if [ "$HEADLESS_SEED_SOURCE_ENABLED" != "1" ]; then
  echo
  echo "For a one-time full mirror bootstrap from your local machine, run:"
  echo "  rsync -av --delete --exclude \".obsidian/\" \"/path/to/local/vault/\" \"$(whoami)@$(hostname):$MIRROR_PATH/\""
fi

if docker compose version >/dev/null 2>&1; then
  if docker compose config --services 2>/dev/null | grep -Fxq "headless-sync"; then
    if ask_yes_no "Start headless sync service now? (docker compose --profile headless-sync up -d --build)" "N"; then
      docker compose --profile headless-sync up -d --build
    fi
  else
    echo "No headless-sync service found in docker-compose.yml. Skipping service start prompt."
  fi
else
  echo "Docker Compose plugin not available. Skipping optional service start."
fi
