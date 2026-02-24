# cURL Examples

## 1) Login

```bash
curl -sS http://localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"secret"}'
```

## 2) Create API Key

```bash
curl -sS http://localhost:8080/v1/apikeys \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"openclaw-agent","scopes":["read","write"]}'
```

## 3) Create Vault

```bash
curl -sS http://localhost:8080/v1/vaults \
  -H "authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"Personal Vault"}'
```

## 4) Push Ops

```bash
curl -sS http://localhost:8080/v1/vaults/$VAULT_ID/sync/push \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "deviceId":"29fce7af-f596-4ec0-84ad-f8a362ff8468",
    "cursor":0,
    "ops":[{
      "idempotencyKey":"op-1",
      "deviceId":"29fce7af-f596-4ec0-84ad-f8a362ff8468",
      "path":"daily.md",
      "opType":"md_update",
      "logicalClock":1,
      "payload":{"yUpdateBase64":"AQID"},
      "createdAt":"2026-02-23T22:00:00Z"
    }]
  }'
```

## 5) Pull Ops

```bash
curl -sS "http://localhost:8080/v1/vaults/$VAULT_ID/sync/pull?since=0&deviceId=$DEVICE_ID" \
  -H "authorization: Bearer $API_KEY"
```
