# cURL Examples (Normalized Variables)

Use these shell variables:

```bash
BASE_URL=http://localhost:8080
DEVICE_ID=11111111-1111-4111-8111-111111111111
```

## 1) Login

```bash
JWT=$(curl -sS "$BASE_URL/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"secret"}' | jq -r '.token')
```

## 2) Create Vault

```bash
VAULT_ID=$(curl -sS "$BASE_URL/v1/vaults" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"Personal Vault"}' | jq -r '.id')
```

## 3) Create API Key

```bash
API_KEY=$(curl -sS "$BASE_URL/v1/apikeys" \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"openclaw-agent","scopes":["read","write"]}' | jq -r '.apiKey')
```

## 4) Register Device

```bash
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/devices/register" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"deviceName\":\"Agent Device\",\"publicKey\":\"PEM_PUBLIC_KEY\"}"
```

## 5) Push Sync Op

```bash
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/sync/push" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"cursor\":0,\"ops\":[{\"idempotencyKey\":\"op-1\",\"deviceId\":\"$DEVICE_ID\",\"path\":\"daily.md\",\"opType\":\"md_update\",\"logicalClock\":1,\"payload\":{\"path\":\"daily.md\",\"yUpdateBase64\":\"AQID\"},\"createdAt\":\"2026-02-25T00:00:00.000Z\"}]}"
```

## 6) Pull Sync Ops

```bash
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/sync/pull?since=0&deviceId=$DEVICE_ID" \
  -H "authorization: Bearer $API_KEY"
```

## 7) Read Key Envelopes

```bash
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/keys?deviceId=$DEVICE_ID" \
  -H "authorization: Bearer $API_KEY"
```

## 8) Blob Upload (Init)

```bash
curl -sS "$BASE_URL/v1/vaults/$VAULT_ID/blobs/init" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"hash":"abc123","size":1024,"chunkCount":1,"cipherAlg":"AES-256-GCM"}'
```

## 9) Health and Metrics

```bash
curl -sS "$BASE_URL/v1/admin/health"
curl -sS "$BASE_URL/metrics" | head
```
