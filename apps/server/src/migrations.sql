CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS vaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  device_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id),
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(vault_id, path)
);

CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id),
  clock BIGINT NOT NULL,
  author_device_id UUID,
  content_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS y_doc_states (
  file_id UUID PRIMARY KEY REFERENCES files(id),
  state_vector TEXT,
  snapshot_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  size BIGINT NOT NULL,
  chunk_count INT NOT NULL,
  cipher_alg TEXT NOT NULL,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blob_chunks (
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  idx INT NOT NULL,
  chunk_hash TEXT NOT NULL,
  size INT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(blob_hash, idx)
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  device_id UUID NOT NULL,
  vault_id UUID NOT NULL REFERENCES vaults(id),
  last_applied_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(device_id, vault_id)
);

CREATE TABLE IF NOT EXISTS op_log (
  seq BIGSERIAL PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES vaults(id),
  file_id UUID,
  op_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  author_device_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS key_envelopes (
  vault_id UUID NOT NULL REFERENCES vaults(id),
  device_id UUID NOT NULL,
  version INT NOT NULL,
  encrypted_vault_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(vault_id, device_id, version)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  hashed_secret TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id),
  file_id UUID NOT NULL REFERENCES files(id),
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_op_log_vault_seq ON op_log(vault_id, seq);
CREATE INDEX IF NOT EXISTS idx_blob_chunks_hash ON blob_chunks(blob_hash);
