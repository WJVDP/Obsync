# Obsync

Self-hosted realtime sync for Obsidian vaults, with CRDT markdown merging, encrypted blob transfer, and automation-friendly HTTP APIs for OpenClaw and other agents.

## One-Line Install

```bash
npm run install:one-line
```

Optional (also installs plugin into a local vault path):

```bash
npm run install:one-line -- "/absolute/path/to/your/vault"
```

## What Obsync Is

Obsync is a single-tenant sync stack for teams or individuals who want full control over their Obsidian sync infrastructure. It combines a TypeScript API server, Postgres metadata storage, MinIO object storage for encrypted chunks, and an Obsidian plugin that supports realtime websocket updates with polling fallback.

## Current Stability

Obsync is currently **ship-ready for private self-host deployments** (single tenant). It is not positioned yet as a multi-tenant SaaS product. You should treat this as production-capable for your own environment, with documented operational runbooks and CI gates.

## Architecture at a Glance

1. **Server (`apps/server`)**: Fastify HTTP + websocket sync APIs.
2. **Postgres**: op log, cursors, key envelopes, metadata.
3. **MinIO / S3**: encrypted blob chunks.
4. **Plugin (`apps/plugin`)**: capture vault events, push/pull sync ops, realtime channel.
5. **Realtime channel**: websocket stream with reconnect and polling fallback.

## Prerequisites

1. Docker Engine
2. Docker Compose plugin (`docker compose`)
3. Node.js 20+
4. npm 10+
5. Obsidian desktop (plugin installed locally)

## 5-Minute Quick Start (VPS + Local Plugin)

### 1) Clone and configure

```bash
git clone https://github.com/WJVDP/Obsync.git
cd Obsync
cp .env.example .env
```

Set at least:

- `NODE_ENV=production`
- `JWT_SECRET=<long-random-secret-at-least-32-chars>`
- `DATABASE_URL=postgres://obsync:obsync@postgres:5432/obsync`

### 2) Start stack

```bash
docker compose up -d
```

### 3) Health check

```bash
curl -sS http://localhost:8080/v1/admin/health
```

Expected: `{"status":"ok",...}`

### 4) Bootstrap first user and create vault

Create first local user (one-time, only when user table is empty):

```bash
BOOTSTRAP_EMAIL=user@example.com BOOTSTRAP_PASSWORD='change-this-password' npm run -w @obsync/server bootstrap:user
```

Login and capture `JWT`:

```bash
BASE_URL=http://localhost:8080
JWT=$(curl -sS "$BASE_URL/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"change-this-password"}' | jq -r '.token')
```

Create vault and capture `VAULT_ID`:

```bash
VAULT_ID=$(curl -sS "$BASE_URL/v1/vaults" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"Personal Vault"}' | jq -r '.id')

echo "$VAULT_ID"
```

### 5) Install plugin locally

On your local machine (with your Obsidian vault path):

```bash
npm install
npm run -w @obsync/plugin install:obsidian -- "/absolute/path/to/your/vault"
```

Plugin files are installed to:

- `<vault>/.obsidian/plugins/obsync/main.js`
- `<vault>/.obsidian/plugins/obsync/manifest.json`

### 6) Configure plugin and connect

In Obsidian:

1. Settings -> Community Plugins -> Reload plugins
2. Enable `Obsync`
3. Settings -> Obsync:
   - `Base URL`: your server URL (for example `http://<vps-ip>:8080`)
   - `Vault ID`: `VAULT_ID`
   - Auth: `Email` + `Password` **or** API token
   - `Realtime`: enabled
4. Click `Connect`

## Verify Realtime Sync

Expected UI signals:

1. Status bar shows `Obsync: Live` when websocket is active.
2. If websocket is unavailable, status falls back to `Obsync: Polling`.

Quick validation:

1. Create `sync-test-a.md` on device A.
2. Confirm it appears on device B without pressing `Sync now`.
3. Rename or delete it on device B; confirm device A converges.

## Use with OpenClaw

### 1) Generate scoped API key

```bash
BASE_URL=http://localhost:8080
API_KEY=$(curl -sS "$BASE_URL/v1/apikeys" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"openclaw-agent","scopes":["read","write"]}' | jq -r '.apiKey')
```

### 2) Minimal read flow

```bash
DEVICE_ID=11111111-1111-4111-8111-111111111111
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/sync/pull?since=0&deviceId=$DEVICE_ID" \
  -H "authorization: Bearer $API_KEY"
```

### 3) Minimal write flow

```bash
DEVICE_ID=11111111-1111-4111-8111-111111111111
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/sync/push" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"cursor\":0,\"ops\":[{\"idempotencyKey\":\"op-001\",\"deviceId\":\"$DEVICE_ID\",\"path\":\"agent.md\",\"opType\":\"md_update\",\"logicalClock\":1,\"payload\":{\"path\":\"agent.md\",\"yUpdateBase64\":\"AQID\"},\"createdAt\":\"2026-02-25T00:00:00.000Z\"}]}"
```

OpenClaw details:

- [OpenClaw playbook](docs/llm/openclaw-playbook.md)
- [Operation recipes](docs/examples/operation-recipes.json)

## Troubleshooting

### `docker compose` command not found

1. Install Docker Desktop or Docker Engine with Compose plugin.
2. Verify with:

```bash
docker compose version
```

### Realtime stuck reconnecting

1. Confirm server logs for websocket errors.
2. Verify plugin now authenticates via `Sec-WebSocket-Protocol`, not query token.
3. Check `GET /v1/admin/health` and network reachability.

### `Vault not found` (404)

1. Ensure plugin `Vault ID` matches API-created vault.
2. Ensure token belongs to the same vault owner account.

### Settings not persisting

Check plugin settings file path:

- `<vault>/.obsidian/plugins/obsync/settings.json`
- fallback: `<vault>/.obsync/settings.json`

## Docs Map

- Architecture overview: [docs/architecture/overview.md](docs/architecture/overview.md)
- API contract: [docs/api/openapi.yaml](docs/api/openapi.yaml)
- Schemas: [docs/schemas](docs/schemas)
- cURL examples: [docs/examples/curl.md](docs/examples/curl.md)
- Plugin install details: [docs/ops/obsidian-plugin-install.md](docs/ops/obsidian-plugin-install.md)
- Ops runbook: [docs/ops/runbook.md](docs/ops/runbook.md)
- SLOs: [docs/ops/slo.md](docs/ops/slo.md)
- OpenClaw playbook: [docs/llm/openclaw-playbook.md](docs/llm/openclaw-playbook.md)
- Release checklist: [docs/ops/release-checklist.md](docs/ops/release-checklist.md)
