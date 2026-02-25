# Release Checklist (Go / No-Go)

Use this checklist before promoting an Obsync build to production.

## Build and Contract Gates

1. `npm run typecheck` passes.
2. `npm run test` passes.
3. `npm run validate:openapi` passes (warnings reviewed and accepted).

## Security Gates

1. `NODE_ENV=production` and strong `JWT_SECRET` configured.
2. Login does not auto-create users.
3. Bootstrap script is disabled/unused after first user creation.
4. Server logs redact authorization and token fields.
5. Realtime auth uses websocket protocol token, not query token.

## Sync Behavior Gates

1. Realtime connection reaches `Live` state under normal conditions.
2. Polling fallback works when websocket is unavailable.
3. Create/rename/delete operations converge across two devices.
4. Binary file upload resumes correctly after interruption.
5. Blob pull/decrypt writes correct local bytes.

## Key Lifecycle Gates

1. Device registration succeeds.
2. Key envelope retrieval succeeds.
3. Key rotation endpoint works with valid admin scope.
4. Existing authorized device remains functional after rotation.

## Observability Gates

1. `/v1/admin/health` reports `ok`.
2. `/metrics` returns Prometheus metrics.
3. Prometheus target `server:8080` is up.
4. Alerting thresholds reviewed for reconnect spikes and latency.

## Rollback Readiness

1. Previous known-good image tag is available.
2. Postgres and MinIO backups are recent and verified.
3. Operator can execute rollback procedure within defined recovery window.

## Go / No-Go Decision

- **Go** if all checklist items pass.
- **No-Go** if any security, sync behavior, or rollback item fails.
