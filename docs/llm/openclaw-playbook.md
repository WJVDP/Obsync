# OpenClaw Playbook

This guide defines safe, deterministic interaction patterns for OpenClaw and other LLM agents using Obsync APIs.

## Quickstart for Agents

## 1) Obtain credentials

Use one of:

1. User JWT from `POST /v1/auth/login`
2. Scoped API key from `POST /v1/apikeys`

Recommended for agents: API key with least privilege.

## 2) Scope matrix

| Task | Required scope |
|---|---|
| List vaults / status | `read` |
| Pull sync operations | `read` |
| Push sync operations | `write` |
| Blob upload/download | `write` for upload, `read` for download |
| Key envelope read | `read` |
| Key rotate | `admin` |
| Create API keys | `admin` |

## 3) Standard environment variables

Use these names in scripts and recipes:

- `BASE_URL`
- `JWT`
- `API_KEY`
- `VAULT_ID`
- `DEVICE_ID`

## Canonical Workflows

## Workflow A: Pull latest with cursor

1. Call:
   - `GET /v1/vaults/{vaultId}/sync/pull?since=<cursor>&deviceId=<DEVICE_ID>`
2. Apply operations in ascending `seq`.
3. Persist `watermark` as new cursor.

## Workflow B: Push markdown update safely

1. Create unique `idempotencyKey`.
2. Send one or more ops to `POST /v1/vaults/{vaultId}/sync/push`.
3. Store `acknowledgedSeq` as cursor.
4. Retry with same `idempotencyKey` on transient failure.

## Workflow C: Upload encrypted blob

1. `POST /v1/vaults/{vaultId}/blobs/init`
2. Upload each missing index with:
   - `PUT /v1/vaults/{vaultId}/blobs/{blobHash}/chunks/{index}`
3. Commit:
   - `POST /v1/vaults/{vaultId}/blobs/{blobHash}/commit`
4. Push `blob_ref` op through sync push.

## Workflow D: Key rotation (human approved)

1. Require explicit human approval first.
2. Build new versioned envelopes per authorized device.
3. Call `POST /v1/vaults/{vaultId}/keys/rotate`.
4. Verify devices can still decrypt and sync.

## Failure Handling Contract

| Code | Meaning | Retry Policy | Escalation |
|---|---|---|---|
| `UNAUTHORIZED` | Missing/invalid token | Do not blind-retry | Refresh creds; human if persistent |
| `FORBIDDEN` | Scope insufficient | Do not retry | Request new scoped key |
| `VAULT_NOT_FOUND` | Unknown/inaccessible vault | Do not retry | Verify `VAULT_ID` and ownership |
| `INVALID_PUSH_PAYLOAD` | Schema mismatch | No retry until fixed | Validate against schema |
| `AUTH_RATE_LIMITED` | Too many login attempts | Back off for window | Human review if repeated |
| `CHUNK_HASH_MISMATCH` | Payload integrity mismatch | Retry after recompute | Escalate on repeated mismatch |
| `BLOB_INCOMPLETE` | Missing chunk(s) before commit | Retry missing chunks only | Escalate if stuck |
| `INTERNAL_ERROR` | Server-side failure | Exponential backoff + jitter | Escalate with trace/log context |

## Security Guardrails

1. Never store or log plaintext vault content unless explicitly running non-E2EE mode.
2. Never place auth tokens in URL query parameters.
3. Use `Authorization: Bearer ...` for HTTP calls.
4. For realtime websocket auth, use `Sec-WebSocket-Protocol: obsync-auth, <token>`.
5. Use least-privilege API keys for automation.
6. Do not rotate keys without explicit human approval.

## Contract References

1. OpenAPI: [docs/api/openapi.yaml](../api/openapi.yaml)
2. Schemas: [docs/schemas](../schemas)
3. Operation recipes: [docs/examples/operation-recipes.json](../examples/operation-recipes.json)
4. cURL examples: [docs/examples/curl.md](../examples/curl.md)
