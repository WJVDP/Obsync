# Endpoint Examples (Minimal + Full)

All examples use these variable names consistently:

- `BASE_URL`
- `JWT`
- `API_KEY`
- `VAULT_ID`
- `DEVICE_ID`

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
Authorization: Bearer <JWT>
```

Full:

```text
GET /v1/vaults
Authorization: Bearer <JWT>
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

## POST /v1/vaults/{vaultId}/devices/register

Minimal:

```json
{"deviceId":"11111111-1111-4111-8111-111111111111","deviceName":"Laptop","publicKey":"PEM_PUBLIC_KEY"}
```

Full:

```json
{"deviceId":"11111111-1111-4111-8111-111111111111","deviceName":"Agent Runner","publicKey":"-----BEGIN RSA PUBLIC KEY-----..."}
```

## POST /v1/vaults/{vaultId}/sync/push

Minimal:

```json
{
  "deviceId": "11111111-1111-4111-8111-111111111111",
  "cursor": 0,
  "ops": [
    {
      "idempotencyKey": "op-1",
      "deviceId": "11111111-1111-4111-8111-111111111111",
      "path": "daily.md",
      "opType": "md_update",
      "logicalClock": 1,
      "payload": {"path":"daily.md","yUpdateBase64":"AQID"},
      "createdAt": "2026-02-25T00:00:00.000Z"
    }
  ]
}
```

Full:

```json
{
  "deviceId": "11111111-1111-4111-8111-111111111111",
  "cursor": 130,
  "ops": [
    {
      "idempotencyKey": "op-131",
      "deviceId": "11111111-1111-4111-8111-111111111111",
      "fileId": "3f45f9f3-d8f6-478f-8f3c-cd10fb2e5f53",
      "path": "notes/project/plan.md",
      "opType": "md_update",
      "logicalClock": 202,
      "payload": {
        "path": "notes/project/plan.md",
        "yUpdateBase64": "AQICAAA=",
        "stateVectorBase64": "AAE="
      },
      "createdAt": "2026-02-25T00:01:10.000Z"
    }
  ]
}
```

## GET /v1/vaults/{vaultId}/sync/pull?since=<seq>

Minimal:

```text
GET /v1/vaults/<VAULT_ID>/sync/pull?since=0&deviceId=<DEVICE_ID>
Authorization: Bearer <API_KEY>
```

Full:

```text
GET /v1/vaults/<VAULT_ID>/sync/pull?since=1200&limit=500&deviceId=<DEVICE_ID>
Authorization: Bearer <API_KEY>
```

## GET /v1/vaults/{vaultId}/keys?deviceId=<uuid>

Minimal:

```text
GET /v1/vaults/<VAULT_ID>/keys?deviceId=<DEVICE_ID>
Authorization: Bearer <API_KEY>
```

Full:

```text
GET /v1/vaults/<VAULT_ID>/keys
Authorization: Bearer <JWT>
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

## GET /v1/vaults/{vaultId}/blobs/{blobHash}

Minimal:

```text
GET /v1/vaults/<VAULT_ID>/blobs/<BLOB_HASH>
Authorization: Bearer <API_KEY>
```

Full:

```text
GET /v1/vaults/<VAULT_ID>/blobs/<BLOB_HASH>
Authorization: Bearer <JWT>
Accept: application/json
```

## GET /v1/vaults/{vaultId}/blobs/{blobHash}/chunks/{index}

Minimal:

```text
GET /v1/vaults/<VAULT_ID>/blobs/<BLOB_HASH>/chunks/0
Authorization: Bearer <API_KEY>
```

Full:

```text
GET /v1/vaults/<VAULT_ID>/blobs/<BLOB_HASH>/chunks/5
Authorization: Bearer <JWT>
Accept: application/json
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
GET /v1/vaults/<VAULT_ID>/status
Authorization: Bearer <API_KEY>
```

Full:

```text
GET /v1/vaults/<VAULT_ID>/status
Authorization: Bearer <JWT>
Accept: application/json
```

## POST /v1/vaults/{vaultId}/keys/rotate

Minimal:

```json
{"version":2,"envelopes":[{"deviceId":"11111111-1111-4111-8111-111111111111","encryptedVaultKey":"BASE64ENC"}]}
```

Full:

```json
{"version":4,"envelopes":[{"deviceId":"11111111-1111-4111-8111-111111111111","encryptedVaultKey":"BASE64ENC1"},{"deviceId":"22222222-2222-4222-8222-222222222222","encryptedVaultKey":"BASE64ENC2"}]}
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

## GET /metrics

Minimal:

```text
GET /metrics
```

Full:

```text
GET /metrics
Accept: text/plain
```
