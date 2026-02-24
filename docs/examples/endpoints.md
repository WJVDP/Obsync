# Endpoint Examples (Minimal + Full)

## POST /v1/auth/login

Minimal:

```json
{"email":"user@example.com","password":"secret"}
```

Full:

```json
{"email":"user@example.com","password":"very-strong-passphrase"}
```

## POST /v1/apikeys

Minimal:

```json
{"name":"openclaw","scopes":["read","write"]}
```

Full:

```json
{"name":"nightly-admin","scopes":["read","write","admin"]}
```

## GET /v1/vaults

Minimal:

```text
GET /v1/vaults
Authorization: Bearer <token>
```

Full:

```text
GET /v1/vaults
Authorization: Bearer <admin-token>
Accept: application/json
```

## POST /v1/vaults

Minimal:

```json
{"name":"Personal Vault"}
```

Full:

```json
{"name":"Project Atlas Vault"}
```

## POST /v1/vaults/{vaultId}/sync/push

Minimal:

```json
{
  "deviceId": "29fce7af-f596-4ec0-84ad-f8a362ff8468",
  "cursor": 0,
  "ops": [
    {
      "idempotencyKey": "op-1",
      "deviceId": "29fce7af-f596-4ec0-84ad-f8a362ff8468",
      "path": "daily.md",
      "opType": "md_update",
      "logicalClock": 1,
      "payload": {"yUpdateBase64":"AQID"},
      "createdAt": "2026-02-23T22:00:00Z"
    }
  ]
}
```

Full:

```json
{
  "deviceId": "29fce7af-f596-4ec0-84ad-f8a362ff8468",
  "cursor": 130,
  "ops": [
    {
      "idempotencyKey": "op-131",
      "deviceId": "29fce7af-f596-4ec0-84ad-f8a362ff8468",
      "fileId": "3f45f9f3-d8f6-478f-8f3c-cd10fb2e5f53",
      "path": "notes/project/plan.md",
      "opType": "md_update",
      "logicalClock": 202,
      "payload": {
        "path": "notes/project/plan.md",
        "yUpdateBase64": "AQICAAA=",
        "stateVectorBase64": "AAE="
      },
      "createdAt": "2026-02-23T22:01:10Z"
    }
  ]
}
```

## GET /v1/vaults/{vaultId}/sync/pull?since=<seq>

Minimal:

```text
GET /v1/vaults/<vaultId>/sync/pull?since=0&deviceId=<deviceId>
Authorization: Bearer <token>
```

Full:

```text
GET /v1/vaults/<vaultId>/sync/pull?since=1200&limit=500&deviceId=<deviceId>
Authorization: Bearer <token>
```

## POST /v1/vaults/{vaultId}/blobs/init

Minimal:

```json
{"hash":"abc123","size":1024,"chunkCount":1,"cipherAlg":"AES-256-GCM"}
```

Full:

```json
{"hash":"74e8d066fbce2f35de4eb2ca36f4f537f6d0af5f08f33f27b44f3c53ad197ecb","size":1428000,"chunkCount":2,"cipherAlg":"AES-256-GCM"}
```

## PUT /v1/vaults/{vaultId}/blobs/{blobHash}/chunks/{index}

Minimal:

```json
{"chunkHash":"9b0f","size":1024,"cipherTextBase64":"AQIDBA=="}
```

Full:

```json
{"chunkHash":"a58f7f5f221df33234f4f0cf6f08fb73a89f2f83ea7b8d0c4f3596f91abb03e4","size":1048576,"cipherTextBase64":"VGhpcyBpcyBhbiBleGFtcGxlLg=="}
```

## POST /v1/vaults/{vaultId}/blobs/{blobHash}/commit

Minimal:

```json
{"hash":"abc123","expectedChunkCount":1,"expectedSize":1024}
```

Full:

```json
{"hash":"74e8d066fbce2f35de4eb2ca36f4f537f6d0af5f08f33f27b44f3c53ad197ecb","expectedChunkCount":2,"expectedSize":1428000}
```

## GET /v1/vaults/{vaultId}/status

Minimal:

```text
GET /v1/vaults/<vaultId>/status
Authorization: Bearer <token>
```

Full:

```text
GET /v1/vaults/<vaultId>/status
Authorization: Bearer <admin-token>
Accept: application/json
```

## POST /v1/vaults/{vaultId}/keys/rotate

Minimal:

```json
{"version":2,"envelopes":[{"deviceId":"29fce7af-f596-4ec0-84ad-f8a362ff8468","encryptedVaultKey":"BASE64ENC"}]}
```

Full:

```json
{"version":4,"envelopes":[{"deviceId":"29fce7af-f596-4ec0-84ad-f8a362ff8468","encryptedVaultKey":"BASE64ENC1"},{"deviceId":"8e6f7792-510c-46d1-a51e-81f8eecb9ef1","encryptedVaultKey":"BASE64ENC2"}]}
```

## GET /v1/admin/health

Minimal:

```text
GET /v1/admin/health
```

Full:

```text
GET /v1/admin/health
Accept: application/json
```
