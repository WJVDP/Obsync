# Runbook

## Deploy (Docker Compose)

1. Copy `.env.example` to `.env`.
2. Start stack:
   - `docker compose up -d`
3. Verify health:
   - `curl http://localhost:8080/v1/admin/health`
4. Access observability:
   - Grafana: `http://localhost:3000` (`admin` / `admin`)
   - Prometheus: `http://localhost:9090`
   - Loki API: `http://localhost:3100`

## Initial Bootstrap

1. Login to create first local account:
   - `POST /v1/auth/login`
2. Create an admin API key:
   - `POST /v1/apikeys` with `scopes: ["read","write","admin"]`
3. Create a vault:
   - `POST /v1/vaults`

## Key Rotation

1. Generate new vault key on trusted device.
2. Encrypt vault key for every active device public key.
3. Call `POST /v1/vaults/{vaultId}/keys/rotate` with incremented version.
4. Monitor plugin telemetry for envelope apply success.

## Backup and Restore

Daily backup target:

1. Postgres dump (encrypted at destination).
2. MinIO bucket snapshot.
3. Server config and environment metadata.

Restore drill (weekly):

1. Restore DB and object store into isolated environment.
2. Validate `GET /v1/admin/health` and one sync pull replay.
3. Confirm vault status and blob commit consistency.

## Incident Response

1. Symptom: push latency spike.
   - Check DB health and op_log growth.
   - Check network path and websocket reconnect churn.
2. Symptom: missing blob commit.
   - Inspect `missingChunks` in push responses.
   - Retry chunk uploads for missing indices.
3. Symptom: auth errors from agent.
   - Validate API key scope and revocation status.
   - Rotate key if leakage suspected.
