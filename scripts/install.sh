#!/usr/bin/env bash
set -euo pipefail; [ -f .env ] || cp .env.example .env; npm install; docker compose up -d; [ -z "${1:-}" ] || npm run -w @obsync/plugin install:obsidian -- "$1"
