# OpenClaw Playbook

This guide defines how OpenClaw/LLM agents should interact with Obsync safely and predictably.

## Auth Scope Matrix

| Task | Required scope |
|---|---|
| Read vault list/status | `read` |
| Pull sync operations | `read` |
| Push sync operations | `write` |
| Blob upload/commit | `write` |
| Rotate key envelopes | `admin` |
| Create API keys | `admin` |

## Deterministic Error Codes

| Code | Meaning | Remediation |
|---|---|---|
| `UNAUTHORIZED` | Missing/invalid token | Refresh credentials and retry |
| `FORBIDDEN` | Missing required scope | Use a key with required scope |
| `VAULT_NOT_FOUND` | Vault is unknown or inaccessible | Verify `vaultId` and owner access |
| `INVALID_PUSH_PAYLOAD` | Schema mismatch | Validate body against JSON Schema |
| `CHUNK_HASH_MISMATCH` | Uploaded chunk hash mismatch | Recompute hash on encrypted bytes |
| `BLOB_INCOMPLETE` | Missing chunk(s) before commit | Upload missing indices then commit |
| `INVALID_ROTATE_KEYS_PAYLOAD` | Key-rotation payload invalid | Include `version` and non-empty envelopes |
| `INTERNAL_ERROR` | Unexpected backend failure | Retry with exponential backoff, escalate with trace id |

## Operation Recipes

Machine-readable recipes are provided at `docs/examples/operation-recipes.json`.

### Recipe: Pull Latest Changes

1. Call `GET /v1/vaults/{vaultId}/sync/pull?since=<cursor>&deviceId=<uuid>`.
2. Apply ops in ascending `seq`.
3. Persist response `watermark` as new cursor.

### Recipe: Upload Attachment

1. Call `POST /blobs/init` with encrypted blob metadata.
2. Upload all `missingIndices` via chunk endpoint.
3. Commit via `/blobs/{blobHash}/commit`.
4. Push `blob_ref` op referencing committed hash.

## Agent Guardrails

1. Never send plaintext note content unless explicitly operating without E2EE.
2. Treat `idempotencyKey` as immutable once used.
3. Retries must be jittered and bounded.
4. Never infer missing chunk payloads; always re-read source bytes.
5. For key rotation, require explicit human approval from calling workflow.
