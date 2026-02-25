import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { v4 as uuidv4 } from "uuid";
import {
  BlobCommitRequestSchema,
  BlobInitRequestSchema,
  ScopeSchema,
  SyncBatchPushRequestSchema,
  type Scope
} from "@obsync/shared";
import { createPool, many, one, runMigrations } from "./db.js";
import { sendError } from "./errors.js";
import { verifyPassword } from "./password.js";
import { readConfig } from "./config.js";
import { generateApiKeySecret, installAuth, resolveAuthContext } from "./auth.js";
import { sha256Hex } from "@obsync/shared";
import { LocalBlobStore, type BlobStore } from "./blobStore.js";
import { RealtimeBus } from "./realtime.js";
import { S3BlobStore } from "./s3BlobStore.js";

const config = readConfig();
const server = Fastify({
  logger: {
    level: config.nodeEnv === "development" ? "debug" : "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.sec-websocket-protocol",
        "req.query.token"
      ],
      censor: "[REDACTED]"
    },
    transport:
      config.nodeEnv === "development"
        ? {
            target: "pino-pretty"
          }
        : undefined
  }
});

const pool = createPool(config.databaseUrl);
const realtimeBus = new RealtimeBus();
const blobStore: BlobStore =
  config.blobStoreMode === "minio"
    ? new S3BlobStore({
        endpoint: config.minioEndpoint,
        bucket: config.minioBucket,
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey,
        region: config.minioRegion
      })
    : new LocalBlobStore(config.dataDir);

await mkdir(config.dataDir, { recursive: true });
await runMigrations(pool);

await server.register(cors, { origin: true });
await server.register(jwt, { secret: config.jwtSecret });
await server.register(websocket);
await installAuth(server, pool);

const LOGIN_RATE_WINDOW_MS = 5 * 60_000;
const LOGIN_RATE_LIMIT_BY_IP = 20;
const LOGIN_RATE_LIMIT_BY_IDENTITY = 10;
const loginAttemptsByIp = new Map<string, number[]>();
const loginAttemptsByIdentity = new Map<string, number[]>();
const requestStartTimes = new WeakMap<object, number>();
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });
const httpRequestsTotal = new Counter({
  name: "obsync_http_requests_total",
  help: "Count of HTTP requests handled by obsync server.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry]
});
const httpRequestDuration = new Histogram({
  name: "obsync_http_request_duration_seconds",
  help: "Request duration in seconds for obsync endpoints.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry]
});

function pruneAttempts(attempts: number[], now: number): number[] {
  return attempts.filter((ts) => now - ts < LOGIN_RATE_WINDOW_MS);
}

function isRateLimited(
  bucket: Map<string, number[]>,
  key: string,
  limit: number,
  now: number
): boolean {
  const attempts = pruneAttempts(bucket.get(key) ?? [], now);
  bucket.set(key, attempts);
  return attempts.length >= limit;
}

function registerAttempt(bucket: Map<string, number[]>, key: string, now: number): void {
  const attempts = pruneAttempts(bucket.get(key) ?? [], now);
  attempts.push(now);
  bucket.set(key, attempts);
}

function clearAttempts(bucket: Map<string, number[]>, key: string): void {
  bucket.delete(key);
}

server.addHook("onRequest", (request, _reply, done) => {
  requestStartTimes.set(request, Date.now());
  done();
});

server.addHook("onResponse", (request, reply, done) => {
  const startedAt = requestStartTimes.get(request) ?? Date.now();
  const durationSeconds = Math.max(0, Date.now() - startedAt) / 1000;
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  const labels = {
    method: request.method,
    route,
    status_code: String(reply.statusCode)
  };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, durationSeconds);
  done();
});

function requireScope(requested: Scope, scopes: Scope[]): boolean {
  return scopes.includes("admin") || scopes.includes(requested);
}

async function assertVaultAccess(vaultId: string, userId: string): Promise<boolean> {
  const row = await one<{ owner_user_id: string }>(
    pool,
    "SELECT owner_user_id FROM vaults WHERE id = $1",
    [vaultId]
  );
  if (!row) {
    return false;
  }
  return row.owner_user_id === userId;
}

server.setErrorHandler((error, _request, reply) => {
  server.log.error(error);
  if (reply.statusCode >= 400 && reply.statusCode < 500) {
    return;
  }

  sendError(reply, 500, {
    code: "INTERNAL_ERROR",
    message: "Unexpected server error",
    remediation: "Retry and inspect server logs"
  });
});

server.post("/v1/auth/login", async (request, reply) => {
  const body = request.body as { email?: string; password?: string };
  if (!body?.email || !body?.password) {
    return sendError(reply, 400, {
      code: "INVALID_CREDENTIALS_PAYLOAD",
      message: "email and password are required"
    });
  }

  const normalizedEmail = body.email.toLowerCase();
  const ipAddress = request.ip;
  const now = Date.now();

  if (
    isRateLimited(loginAttemptsByIp, ipAddress, LOGIN_RATE_LIMIT_BY_IP, now) ||
    isRateLimited(loginAttemptsByIdentity, normalizedEmail, LOGIN_RATE_LIMIT_BY_IDENTITY, now)
  ) {
    return sendError(reply, 429, {
      code: "AUTH_RATE_LIMITED",
      message: "Too many login attempts",
      remediation: "Wait a few minutes before retrying"
    });
  }

  const user = await one<{ id: string; email: string; password_hash: string }>(
    pool,
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [normalizedEmail]
  );

  if (!user || !verifyPassword(body.password, user.password_hash)) {
    registerAttempt(loginAttemptsByIp, ipAddress, now);
    registerAttempt(loginAttemptsByIdentity, normalizedEmail, now);
    return sendError(reply, 401, {
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password"
    });
  }

  clearAttempts(loginAttemptsByIp, ipAddress);
  clearAttempts(loginAttemptsByIdentity, normalizedEmail);
  const token = await reply.jwtSign({ userId: user.id, email: user.email }, { expiresIn: "12h" });
  return reply.send({ token, userId: user.id });
});

server.post("/v1/apikeys", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("admin", request.authContext.scopes)) {
    return sendError(reply, 403, {
      code: "FORBIDDEN",
      message: "admin scope required"
    });
  }

  const body = request.body as { name?: string; scopes?: Scope[] };
  const scopes = (body?.scopes ?? ["read", "write"]).filter((scope): scope is Scope =>
    ScopeSchema.safeParse(scope).success
  );
  if (!body?.name || scopes.length === 0) {
    return sendError(reply, 400, {
      code: "INVALID_API_KEY_PAYLOAD",
      message: "name and at least one valid scope are required"
    });
  }

  const apiKey = generateApiKeySecret();
  const hashedSecret = sha256Hex(apiKey);

  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO api_keys(user_id, name, hashed_secret, scopes)
     VALUES($1, $2, $3, $4)
     RETURNING id`,
    [request.authContext.userId, body.name, hashedSecret, scopes]
  );

  return reply.status(201).send({ id: row?.id, name: body.name, scopes, apiKey });
});

server.get("/v1/vaults", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const rows = await many<{ id: string; name: string; created_at: Date }>(
    pool,
    `SELECT id, name, created_at
     FROM vaults
     WHERE owner_user_id = $1
     ORDER BY created_at DESC`,
    [request.authContext.userId]
  );

  return reply.send(rows);
});

server.post("/v1/vaults", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const body = request.body as { name?: string };
  if (!body?.name) {
    return sendError(reply, 400, {
      code: "INVALID_VAULT_PAYLOAD",
      message: "name is required"
    });
  }

  const row = await one<{ id: string; name: string; created_at: Date }>(
    pool,
    `INSERT INTO vaults(name, owner_user_id)
     VALUES($1, $2)
     RETURNING id, name, created_at`,
    [body.name, request.authContext.userId]
  );

  return reply.status(201).send(row);
});

server.post("/v1/vaults/:vaultId/devices/register", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const body = request.body as { deviceId?: string; deviceName?: string; publicKey?: string };
  if (!body?.deviceId || !body.deviceName || !body.publicKey) {
    return sendError(reply, 400, {
      code: "INVALID_DEVICE_PAYLOAD",
      message: "deviceId, deviceName and publicKey are required"
    });
  }

  await pool.query(
    `INSERT INTO devices(id, user_id, device_name, public_key, last_seen_at)
     VALUES($1, $2, $3, $4, now())
     ON CONFLICT (id)
     DO UPDATE SET user_id = EXCLUDED.user_id, device_name = EXCLUDED.device_name, public_key = EXCLUDED.public_key, last_seen_at = now()`,
    [body.deviceId, request.authContext.userId, body.deviceName, body.publicKey]
  );

  return reply.status(201).send({ id: body.deviceId, deviceName: body.deviceName, registered: true });
});

server.post("/v1/vaults/:vaultId/sync/push", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const parsed = SyncBatchPushRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendError(reply, 400, {
      code: "INVALID_PUSH_PAYLOAD",
      message: "Request body does not match schema",
      details: parsed.error.flatten()
    });
  }

  const requestBody = parsed.data;
  const missingChunks: Array<{ blobHash: string; index: number }> = [];

  let acknowledgedSeq = requestBody.cursor;
  let appliedCount = 0;

  for (const op of requestBody.ops) {
    const insert = await pool.query<{ seq: string }>(
      `INSERT INTO op_log(vault_id, file_id, op_type, payload, idempotency_key, author_device_id)
       VALUES($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING seq`,
      [vaultId, op.fileId ?? null, op.opType, JSON.stringify(op.payload), op.idempotencyKey, op.deviceId]
    );

    let seq = insert.rows[0]?.seq ? Number(insert.rows[0].seq) : 0;
    if (!seq) {
      const existing = await one<{ seq: string }>(
        pool,
        "SELECT seq FROM op_log WHERE idempotency_key = $1",
        [op.idempotencyKey]
      );
      seq = Number(existing?.seq ?? 0);
    } else {
      appliedCount += 1;
      realtimeBus.publish({
        vaultId,
        seq,
        opType: op.opType,
        payload: op.payload,
        createdAt: new Date().toISOString()
      });
    }

    if (op.opType === "blob_ref") {
      const blobHash = String(op.payload.blobHash ?? "");
      if (blobHash) {
        const blob = await one<{ hash: string; committed_at: Date | null }>(
          pool,
          "SELECT hash, committed_at FROM blobs WHERE hash = $1",
          [blobHash]
        );
        if (!blob || !blob.committed_at) {
          missingChunks.push({ blobHash, index: Number(op.payload.index ?? 0) });
        }
      }
    }

    acknowledgedSeq = Math.max(acknowledgedSeq, seq);
  }

  await pool.query(
    `INSERT INTO sync_cursors(device_id, vault_id, last_applied_seq)
     VALUES($1, $2, $3)
     ON CONFLICT (device_id, vault_id)
     DO UPDATE SET last_applied_seq = EXCLUDED.last_applied_seq, updated_at = now()`,
    [requestBody.deviceId, vaultId, acknowledgedSeq]
  );
  await pool.query(
    `UPDATE devices SET last_seen_at = now()
     WHERE id = $1 AND user_id = $2`,
    [requestBody.deviceId, request.authContext.userId]
  );

  return reply.send({
    acknowledgedSeq,
    appliedCount,
    missingChunks,
    rebaseRequired: false
  });
});

server.get("/v1/vaults/:vaultId/sync/pull", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const query = request.query as { since?: string; limit?: string; deviceId?: string };
  const since = Number(query.since ?? "0");
  const limit = Math.min(Number(query.limit ?? "200"), 1000);

  const ops = await many<{
    seq: string;
    vault_id: string;
    file_id: string | null;
    op_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    pool,
    `SELECT seq, vault_id, file_id, op_type, payload, created_at
     FROM op_log
     WHERE vault_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [vaultId, since, limit]
  );

  const watermark = ops.length > 0 ? Number(ops[ops.length - 1].seq) : since;

  if (query.deviceId) {
    await pool.query(
      `INSERT INTO sync_cursors(device_id, vault_id, last_applied_seq)
       VALUES($1, $2, $3)
       ON CONFLICT (device_id, vault_id)
       DO UPDATE SET last_applied_seq = GREATEST(sync_cursors.last_applied_seq, EXCLUDED.last_applied_seq), updated_at = now()`,
      [query.deviceId, vaultId, watermark]
    );
    await pool.query(
      `UPDATE devices SET last_seen_at = now()
       WHERE id = $1 AND user_id = $2`,
      [query.deviceId, request.authContext.userId]
    );
  }

  return reply.send({
    watermark,
    ops: ops.map((op) => ({
      seq: Number(op.seq),
      vaultId: op.vault_id,
      fileId: op.file_id,
      opType: op.op_type,
      payload: op.payload,
      createdAt: op.created_at.toISOString()
    }))
  });
});

server.post("/v1/vaults/:vaultId/blobs/init", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const parsed = BlobInitRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendError(reply, 400, {
      code: "INVALID_BLOB_INIT_PAYLOAD",
      message: "Request body does not match schema",
      details: parsed.error.flatten()
    });
  }

  const payload = parsed.data;
  await pool.query(
    `INSERT INTO blobs(hash, size, chunk_count, cipher_alg)
     VALUES($1, $2, $3, $4)
     ON CONFLICT (hash) DO NOTHING`,
    [payload.hash, payload.size, payload.chunkCount, payload.cipherAlg]
  );

  const existingChunks = await many<{ idx: number }>(
    pool,
    `SELECT idx FROM blob_chunks WHERE blob_hash = $1 ORDER BY idx ASC`,
    [payload.hash]
  );

  const existingSet = new Set(existingChunks.map((chunk) => Number(chunk.idx)));
  const missingIndices: number[] = [];
  for (let index = 0; index < payload.chunkCount; index += 1) {
    if (!existingSet.has(index)) {
      missingIndices.push(index);
    }
  }

  return reply.status(201).send({
    uploadId: uuidv4(),
    hash: payload.hash,
    missingIndices
  });
});

server.put("/v1/vaults/:vaultId/blobs/:blobHash/chunks/:index", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const { vaultId, blobHash, index } = request.params as {
    vaultId: string;
    blobHash: string;
    index: string;
  };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const body = request.body as {
    chunkHash?: string;
    size?: number;
    cipherTextBase64?: string;
  };

  if (!body?.chunkHash || !body?.size || !body?.cipherTextBase64) {
    return sendError(reply, 400, {
      code: "INVALID_CHUNK_PAYLOAD",
      message: "chunkHash, size and cipherTextBase64 are required"
    });
  }

  const raw = Buffer.from(body.cipherTextBase64, "base64");
  const calculatedHash = sha256Hex(raw);
  if (calculatedHash !== body.chunkHash) {
    return sendError(reply, 409, {
      code: "CHUNK_HASH_MISMATCH",
      message: "Chunk hash does not match payload",
      remediation: "Recompute chunk hash and retry"
    });
  }

  const numericIndex = Number(index);
  const storageKey = await blobStore.writeChunk(blobHash, numericIndex, raw);

  await pool.query(
    `INSERT INTO blob_chunks(blob_hash, idx, chunk_hash, size, storage_key)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT(blob_hash, idx)
     DO UPDATE SET chunk_hash = EXCLUDED.chunk_hash, size = EXCLUDED.size, storage_key = EXCLUDED.storage_key`,
    [blobHash, numericIndex, body.chunkHash, body.size, storageKey]
  );

  return reply.send({
    blobHash,
    index: numericIndex,
    persisted: true
  });
});

server.get("/v1/vaults/:vaultId/blobs/:blobHash", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const { vaultId, blobHash } = request.params as { vaultId: string; blobHash: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const blob = await one<{
    hash: string;
    size: string;
    chunk_count: number;
    cipher_alg: string;
    committed_at: Date | null;
  }>(
    pool,
    `SELECT hash, size::text, chunk_count, cipher_alg, committed_at
     FROM blobs
     WHERE hash = $1`,
    [blobHash]
  );
  if (!blob || !blob.committed_at) {
    return sendError(reply, 404, { code: "BLOB_NOT_FOUND", message: "Blob not found" });
  }

  const chunks = await many<{ idx: number; chunk_hash: string; size: number }>(
    pool,
    `SELECT idx, chunk_hash, size
     FROM blob_chunks
     WHERE blob_hash = $1
     ORDER BY idx ASC`,
    [blobHash]
  );

  return reply.send({
    hash: blob.hash,
    size: Number(blob.size),
    chunkCount: blob.chunk_count,
    cipherAlg: blob.cipher_alg,
    chunks: chunks.map((chunk) => ({
      index: Number(chunk.idx),
      chunkHash: chunk.chunk_hash,
      size: Number(chunk.size)
    }))
  });
});

server.get("/v1/vaults/:vaultId/blobs/:blobHash/chunks/:index", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const { vaultId, blobHash, index } = request.params as {
    vaultId: string;
    blobHash: string;
    index: string;
  };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const chunk = await one<{ storage_key: string; chunk_hash: string; size: number }>(
    pool,
    `SELECT storage_key, chunk_hash, size
     FROM blob_chunks
     WHERE blob_hash = $1 AND idx = $2`,
    [blobHash, Number(index)]
  );
  if (!chunk) {
    return sendError(reply, 404, { code: "CHUNK_NOT_FOUND", message: "Chunk not found" });
  }

  const raw = await blobStore.readChunk(chunk.storage_key);
  return reply.send({
    blobHash,
    index: Number(index),
    chunkHash: chunk.chunk_hash,
    size: chunk.size,
    cipherTextBase64: raw.toString("base64")
  });
});

server.post("/v1/vaults/:vaultId/blobs/:blobHash/commit", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("write", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "write scope required" });
  }

  const { vaultId, blobHash } = request.params as { vaultId: string; blobHash: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const parsed = BlobCommitRequestSchema.safeParse(request.body);
  if (!parsed.success || parsed.data.hash !== blobHash) {
    return sendError(reply, 400, {
      code: "INVALID_BLOB_COMMIT_PAYLOAD",
      message: "Request body does not match schema or blob hash"
    });
  }

  const payload = parsed.data;
  const result = await one<{ count: string; size: string }>(
    pool,
    `SELECT count(*)::text AS count, coalesce(sum(size), 0)::text AS size
     FROM blob_chunks
     WHERE blob_hash = $1`,
    [blobHash]
  );

  const currentCount = Number(result?.count ?? 0);
  const currentSize = Number(result?.size ?? 0);

  if (currentCount < payload.expectedChunkCount || currentSize < payload.expectedSize) {
    return sendError(reply, 409, {
      code: "BLOB_INCOMPLETE",
      message: "Blob chunks are incomplete",
      details: {
        expectedChunkCount: payload.expectedChunkCount,
        expectedSize: payload.expectedSize,
        currentCount,
        currentSize
      },
      remediation: "Upload missing chunks and retry commit"
    });
  }

  await pool.query("UPDATE blobs SET committed_at = now() WHERE hash = $1", [blobHash]);
  return reply.send({ hash: blobHash, committed: true });
});

server.get("/v1/vaults/:vaultId/status", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const latestSeq = await one<{ seq: string | null }>(
    pool,
    "SELECT max(seq)::text AS seq FROM op_log WHERE vault_id = $1",
    [vaultId]
  );

  const activeDevices = await one<{ count: string }>(
    pool,
    `SELECT count(*)::text AS count
     FROM devices
     WHERE user_id = $1 AND (last_seen_at IS NULL OR last_seen_at > now() - interval '15 minutes')`,
    [request.authContext.userId]
  );

  const pendingBlobCount = await one<{ count: string }>(
    pool,
    "SELECT count(*)::text AS count FROM blobs WHERE committed_at IS NULL"
  );

  return reply.send({
    vaultId,
    latestSeq: Number(latestSeq?.seq ?? 0),
    activeDevices: Number(activeDevices?.count ?? 0),
    pendingBlobCount: Number(pendingBlobCount?.count ?? 0),
    serverTime: new Date().toISOString()
  });
});

server.get("/v1/vaults/:vaultId/keys", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("read", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "read scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const query = request.query as { deviceId?: string };
  const rows = await many<{ device_id: string; version: number; encrypted_vault_key: string }>(
    pool,
    `SELECT device_id, version, encrypted_vault_key
     FROM key_envelopes
     WHERE vault_id = $1
       AND ($2::uuid IS NULL OR device_id = $2::uuid)
     ORDER BY version DESC`,
    [vaultId, query.deviceId ?? null]
  );

  return reply.send({
    vaultId,
    envelopes: rows.map((row) => ({
      deviceId: row.device_id,
      version: Number(row.version),
      encryptedVaultKey: row.encrypted_vault_key
    }))
  });
});

server.post("/v1/vaults/:vaultId/keys/rotate", { preHandler: server.authenticate }, async (request, reply) => {
  if (!request.authContext || !requireScope("admin", request.authContext.scopes)) {
    return sendError(reply, 403, { code: "FORBIDDEN", message: "admin scope required" });
  }

  const { vaultId } = request.params as { vaultId: string };
  if (!(await assertVaultAccess(vaultId, request.authContext.userId))) {
    return sendError(reply, 404, { code: "VAULT_NOT_FOUND", message: "Vault not found" });
  }

  const body = request.body as {
    version?: number;
    envelopes?: Array<{ deviceId: string; encryptedVaultKey: string }>;
  };

  if (!body?.version || !body?.envelopes || body.envelopes.length === 0) {
    return sendError(reply, 400, {
      code: "INVALID_ROTATE_KEYS_PAYLOAD",
      message: "version and envelopes[] are required"
    });
  }

  for (const envelope of body.envelopes) {
    await pool.query(
      `INSERT INTO key_envelopes(vault_id, device_id, version, encrypted_vault_key)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (vault_id, device_id, version)
       DO UPDATE SET encrypted_vault_key = EXCLUDED.encrypted_vault_key`,
      [vaultId, envelope.deviceId, body.version, envelope.encryptedVaultKey]
    );
  }

  return reply.send({ vaultId, version: body.version, updated: body.envelopes.length });
});

server.get("/v1/admin/health", async (_request, reply) => {
  const dbCheck = await one<{ alive: number }>(pool, "SELECT 1 AS alive");
  return reply.send({
    status: dbCheck?.alive === 1 ? "ok" : "degraded",
    db: dbCheck?.alive === 1,
    serverTime: new Date().toISOString()
  });
});

server.get("/metrics", async (_request, reply) => {
  reply.header("content-type", metricsRegistry.contentType);
  return reply.send(await metricsRegistry.metrics());
});

server.get(
  "/v1/vaults/:vaultId/realtime",
  {
    websocket: true
  },
  async (socket, request) => {
    const authContext = await resolveAuthContext(server, pool, request);
    request.authContext = authContext;

    const sendRealtimeError = (code: string, message: string, remediation: string): void => {
      socket.send(JSON.stringify({ type: "error", code, message, remediation }));
      socket.close();
    };

    if (!authContext || !requireScope("read", authContext.scopes)) {
      sendRealtimeError(
        authContext ? "FORBIDDEN" : "UNAUTHORIZED",
        authContext ? "read scope required" : "Missing or invalid bearer token",
        authContext ? "Use a key with read scope" : "Provide valid JWT or API key"
      );
      return;
    }

    const { vaultId } = request.params as { vaultId: string };
    if (!(await assertVaultAccess(vaultId, authContext.userId))) {
      sendRealtimeError("VAULT_NOT_FOUND", "Vault not found", "Verify vaultId and owner access");
      return;
    }

    const query = request.query as { since?: string };
    const since = Number(query.since ?? "0");

    const backlog = await many<{
      seq: string;
      op_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      pool,
      `SELECT seq, op_type, payload, created_at
       FROM op_log
       WHERE vault_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT 500`,
      [vaultId, since]
    );

    socket.send(
      JSON.stringify({
        type: "backlog",
        events: backlog.map((row) => ({
          seq: Number(row.seq),
          opType: row.op_type,
          payload: row.payload,
          createdAt: row.created_at.toISOString()
        }))
      })
    );

    const unsubscribe = realtimeBus.subscribe(vaultId, (event) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "event", ...event }));
      }
    });

    const keepalive = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "keepalive", ts: new Date().toISOString() }));
      }
    }, 20_000);

    socket.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  }
);

async function start(): Promise<void> {
  try {
    await server.listen({ port: config.port, host: "0.0.0.0" });
    server.log.info({ port: config.port }, "obsync server started");
  } catch (error) {
    server.log.error(error);
    await pool.end();
    process.exit(1);
  }
}

start();
