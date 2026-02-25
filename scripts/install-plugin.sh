#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "Usage: sh install-plugin.sh /absolute/path/to/your/vault" >&2
  exit 1
fi

VAULT_PATH="$1"
if [ ! -d "$VAULT_PATH" ]; then
  echo "Vault directory not found: $VAULT_PATH" >&2
  exit 1
fi

REF="${OBSYNC_REF:-main}"
RAW_BASE="${OBSYNC_RAW_BASE:-https://raw.githubusercontent.com/WJVDP/Obsync/$REF}"
TARGET_DIR="$VAULT_PATH/.obsidian/plugins/obsync"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOCAL_MAIN="$REPO_ROOT/apps/plugin/dist-obsidian/main.js"
LOCAL_MANIFEST_SRC="$REPO_ROOT/apps/plugin/manifest.json"

mkdir -p "$TARGET_DIR"

if [ -f "$LOCAL_MAIN" ]; then
  cp "$LOCAL_MAIN" "$TARGET_DIR/main.js"
  cp "$LOCAL_MANIFEST_SRC" "$TARGET_DIR/manifest.json"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "Missing required command: curl" >&2
    exit 1
  fi
  curl -fsSL "$RAW_BASE/apps/plugin/dist-obsidian/main.js" -o "$TARGET_DIR/main.js"
  curl -fsSL "$RAW_BASE/apps/plugin/manifest.json" -o "$TARGET_DIR/manifest.json"
fi

echo "Installed Obsync plugin to $TARGET_DIR"
echo "In Obsidian: Settings -> Community Plugins -> Reload plugins, then enable Obsync."
