## 2026-02-23 1.0.0

### Added
- Endpoint: `POST /v1/auth/login`
- Endpoint: `POST /v1/apikeys`
- Endpoint: `GET /v1/vaults`
- Endpoint: `POST /v1/vaults`
- Endpoint: `POST /v1/vaults/{vaultId}/sync/push`
- Endpoint: `GET /v1/vaults/{vaultId}/sync/pull`
- Endpoint: `POST /v1/vaults/{vaultId}/blobs/init`
- Endpoint: `PUT /v1/vaults/{vaultId}/blobs/{blobHash}/chunks/{index}`
- Endpoint: `POST /v1/vaults/{vaultId}/blobs/{blobHash}/commit`
- Endpoint: `GET /v1/vaults/{vaultId}/status`
- Endpoint: `POST /v1/vaults/{vaultId}/keys/rotate`
- Endpoint: `GET /v1/admin/health`
- Schemas: `SyncOp`, `SyncBatchPushRequest`, `SyncBatchPushResponse`, `PullResponse`, `BlobInitRequest`, `BlobCommitRequest`, `ConflictRecord`, `VaultStatus`, `ErrorEnvelope`

### Changed
- None

### Deprecated
- None

### Removed
- None

### Error Codes
- Added: `UNAUTHORIZED`, `FORBIDDEN`, `VAULT_NOT_FOUND`, `INVALID_PUSH_PAYLOAD`, `CHUNK_HASH_MISMATCH`, `BLOB_INCOMPLETE`, `INVALID_ROTATE_KEYS_PAYLOAD`, `INTERNAL_ERROR`
