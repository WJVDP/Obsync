# Operations Runbook (VPS First)

This runbook assumes:

1. Obsync server stack runs on a VPS.
2. Obsidian plugin runs on user desktops/mobile devices.
3. Deployment model is single-tenant self-host.

## Deploy / Upgrade

From server host repo path:

```bash
git pull --ff-only
cp .env.example .env  # first run only
docker compose up -d --build
```

## Baseline Verification

```bash
curl -sS http://localhost:8080/v1/admin/health
curl -sS http://localhost:8080/metrics | head
```

Expected:

1. Health status: `ok`
2. Metrics endpoint returns Prometheus text output

## First User Bootstrap (One-Time)

If no users exist yet:

```bash
BOOTSTRAP_EMAIL=user@example.com BOOTSTRAP_PASSWORD='change-this-password' npm run -w @obsync/server bootstrap:user
```

Notes:

1. Bootstrap fails if users already exist.
2. Login endpoint no longer auto-creates users.

## Access and Vault Setup

```bash
BASE_URL=http://localhost:8080
JWT=$(curl -sS "$BASE_URL/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"change-this-password"}' | jq -r '.token')

VAULT_ID=$(curl -sS "$BASE_URL/v1/vaults" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"Personal Vault"}' | jq -r '.id')
```

## API Key Management

Create scoped key:

```bash
curl -sS "$BASE_URL/v1/apikeys" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"openclaw-agent","scopes":["read","write"]}'
```

## Device Registration and Key Envelopes

Plugin performs registration automatically at connect time using:

1. `POST /v1/vaults/{vaultId}/devices/register`
2. `GET /v1/vaults/{vaultId}/keys?deviceId=<uuid>`
3. `POST /v1/vaults/{vaultId}/keys/rotate` (when needed)

Operational check:

1. Confirm `devices` table has recent `last_seen_at` values.
2. Confirm `key_envelopes` rows exist for active devices.

## Backups and Restore Drill

Daily backup:

1. Postgres logical dump (encrypted destination).
2. MinIO bucket snapshot.
3. `.env` and deployment metadata.

Weekly restore drill:

1. Restore into isolated environment.
2. Verify health, login, vault listing, and one sync pull replay.
3. Verify blob chunk retrieval and commit integrity.

## Incident Playbooks

### Realtime reconnect storm

1. Check websocket errors in server logs.
2. Verify network, TLS/proxy config, and auth validity.
3. Confirm clients still progress via polling fallback.

### Auth failures

1. Confirm user exists (bootstrap completed).
2. Confirm key not revoked and scope is sufficient.
3. Check rate-limit events (`AUTH_RATE_LIMITED`).

### Blob failures

1. Inspect `BLOB_INCOMPLETE` and `missingChunks` responses.
2. Retry missing chunk upload and commit.

## Release Gates

Use [release checklist](./release-checklist.md) before production promotion.
