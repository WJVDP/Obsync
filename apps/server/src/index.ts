import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";
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
import { hashPassword, verifyPassword } from "./password.js";
import { readConfig } from "./config.js";
import { generateApiKeySecret, installAuth } from "./auth.js";
import { sha256Hex } from "@obsync/shared";
import { LocalBlobStore, type BlobStore } from "./blobStore.js";
import { RealtimeBus } from "./realtime.js";
import { S3BlobStore } from "./s3BlobStore.js";

const config = readConfig();
const server = Fastify({
  logger: {
    level: config.nodeEnv === "development" ? "debug" : "info",
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

  let user = await one<{ id: string; email: string; password_hash: string }>(
    pool,
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [body.email.toLowerCase()]
  );

  if (!user) {
    const passwordHash = hashPassword(body.password);
    user = await one<{ id: string; email: string; password_hash: string }>(
      pool,
      `INSERT INTO users(email, password_hash)
       VALUES($1, $2)
       RETURNING id, email, password_hash`,
      [body.email.toLowerCase(), passwordHash]
    );
  }

  if (!user || !verifyPassword(body.password, user.password_hash)) {
    return sendError(reply, 401, {
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password"
    });
  }

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

server.get(
  "/v1/vaults/:vaultId/realtime",
  {
    websocket: true,
    preValidation: server.authenticate
  },
  async (connection, request) => {
    const authContext = request.authContext;
    if (!authContext || !requireScope("read", authContext.scopes)) {
      connection.socket.send(
        JSON.stringify({ code: "FORBIDDEN", message: "read scope required" })
      );
      connection.socket.close();
      return;
    }

    const { vaultId } = request.params as { vaultId: string };
    if (!(await assertVaultAccess(vaultId, authContext.userId))) {
      connection.socket.send(JSON.stringify({ code: "VAULT_NOT_FOUND", message: "Vault not found" }));
      connection.socket.close();
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

    connection.socket.send(
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
      connection.socket.send(JSON.stringify({ type: "event", ...event }));
    });

    const keepalive = setInterval(() => {
      if (connection.socket.readyState === 1) {
        connection.socket.send(JSON.stringify({ type: "keepalive", ts: new Date().toISOString() }));
      }
    }, 20_000);

    connection.socket.on("close", () => {
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
