import { z } from "zod";

export const ScopeSchema = z.enum(["read", "write", "admin"]);
export type Scope = z.infer<typeof ScopeSchema>;

export const OpTypeSchema = z.enum([
  "md_update",
  "file_create",
  "file_rename",
  "file_delete",
  "blob_ref",
  "key_rotate"
]);

export const SyncOpSchema = z.object({
  idempotencyKey: z.string().min(8),
  deviceId: z.string().uuid(),
  fileId: z.string().uuid().optional(),
  path: z.string().min(1),
  opType: OpTypeSchema,
  logicalClock: z.number().int().nonnegative(),
  payload: z.record(z.any()),
  createdAt: z.string().datetime()
});

export type SyncOp = z.infer<typeof SyncOpSchema>;

export const SyncBatchPushRequestSchema = z.object({
  deviceId: z.string().uuid(),
  cursor: z.number().int().nonnegative().default(0),
  ops: z.array(SyncOpSchema).min(1)
});

export const SyncBatchPushResponseSchema = z.object({
  acknowledgedSeq: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative(),
  missingChunks: z.array(z.object({ blobHash: z.string(), index: z.number().int().nonnegative() })).default([]),
  rebaseRequired: z.boolean().default(false)
});

export const PullResponseSchema = z.object({
  watermark: z.number().int().nonnegative(),
  ops: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      vaultId: z.string().uuid(),
      fileId: z.string().uuid().nullable(),
      opType: OpTypeSchema,
      payload: z.record(z.any()),
      createdAt: z.string().datetime()
    })
  )
});

export const BlobInitRequestSchema = z.object({
  hash: z.string().min(32),
  size: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  cipherAlg: z.string().default("AES-256-GCM")
});

export const BlobCommitRequestSchema = z.object({
  hash: z.string().min(32),
  expectedChunkCount: z.number().int().positive(),
  expectedSize: z.number().int().positive()
});

export const ConflictRecordSchema = z.object({
  id: z.string().uuid(),
  vaultId: z.string().uuid(),
  fileId: z.string().uuid(),
  path: z.string(),
  reason: z.string(),
  createdAt: z.string().datetime(),
  resolution: z.enum(["pending", "restored", "ignored"]).default("pending")
});

export const VaultStatusSchema = z.object({
  vaultId: z.string().uuid(),
  latestSeq: z.number().int().nonnegative(),
  activeDevices: z.number().int().nonnegative(),
  pendingBlobCount: z.number().int().nonnegative(),
  serverTime: z.string().datetime()
});

export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  remediation: z.string().optional(),
  details: z.record(z.any()).optional(),
  traceId: z.string().optional()
});

export type SyncBatchPushRequest = z.infer<typeof SyncBatchPushRequestSchema>;
export type SyncBatchPushResponse = z.infer<typeof SyncBatchPushResponseSchema>;
export type PullResponse = z.infer<typeof PullResponseSchema>;
export type BlobInitRequest = z.infer<typeof BlobInitRequestSchema>;
export type BlobCommitRequest = z.infer<typeof BlobCommitRequestSchema>;
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;
export type VaultStatus = z.infer<typeof VaultStatusSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
