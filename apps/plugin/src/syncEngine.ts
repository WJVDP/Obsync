import {
  decryptVaultKeyForDevice,
  encryptVaultKeyForDevice,
  generateVaultKey,
  type SyncOp
} from "@obsync/shared";
import type { VaultEvent } from "./event-capture/vaultEventCapture.js";
import { SyncOpBuilder } from "./op-builder/syncOpBuilder.js";
import { SyncStateStore } from "./state-store/stateStore.js";
import { SyncTransport } from "./transport/syncTransport.js";
import { TelemetryClient } from "./telemetry/telemetryClient.js";
import { YjsMarkdownEngine } from "./crdt-engine/yjsEngine.js";
import { BlobSyncEngine } from "./blob-engine/blobSyncEngine.js";

export interface SyncEngineOptions {
  vaultId: string;
  deviceId: string;
  deviceName?: string;
  devicePublicKeyPem?: string;
  devicePrivateKeyPem?: string;
  maxBatchSize?: number;
  onRemoteMarkdown?: (path: string, content: string) => Promise<void> | void;
  onRemoteFileCreate?: (path: string, content?: string) => Promise<void> | void;
  onRemoteFileRename?: (oldPath: string, newPath: string) => Promise<void> | void;
  onRemoteFileDelete?: (path: string) => Promise<void> | void;
  onRemoteBinaryFile?: (path: string, content: Buffer) => Promise<void> | void;
  onRealtimeOpen?: () => void;
  onRealtimeClose?: () => void;
  onRealtimeError?: () => void;
}

export class SyncEngine {
  private readonly maxBatchSize: number;
  private realtimeSocket: WebSocket | null = null;
  private readonly opBuilder: SyncOpBuilder;
  private readonly blobEngine = new BlobSyncEngine();

  constructor(
    private readonly options: SyncEngineOptions,
    private readonly transport: SyncTransport,
    private readonly stateStore: SyncStateStore,
    private readonly crdtEngine: YjsMarkdownEngine,
    private readonly telemetry: TelemetryClient
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.opBuilder = new SyncOpBuilder(options.deviceId);
  }

  async initialize(): Promise<void> {
    await this.stateStore.load();
    await this.bootstrapKeys();
  }

  async handleVaultEvent(event: VaultEvent): Promise<void> {
    const op = await this.buildOperation(event);
    await this.stateStore.addOutboxOps([op]);
    await this.flushOutbox();
  }

  private async buildOperation(event: VaultEvent): Promise<SyncOp> {
    if (event.type === "modify" && event.path.endsWith(".md") && event.content !== undefined) {
      const snapshot = this.crdtEngine.applyText(event.path, event.content);
      const op = this.opBuilder.fromVaultEvent(
        {
          ...event,
          content: undefined
        },
        undefined
      );
      return {
        ...op,
        payload: {
          ...op.payload,
          path: event.path,
          yUpdateBase64: snapshot.updateBase64,
          stateVectorBase64: snapshot.stateVectorBase64
        }
      };
    }

    if (
      (event.type === "create" || event.type === "modify") &&
      !event.path.endsWith(".md") &&
      event.binaryContentBase64
    ) {
      const raw = Buffer.from(event.binaryContentBase64, "base64");
      const vaultKey = await this.ensureVaultKey();
      const plan = this.blobEngine.planUpload(raw, vaultKey);

      const init = await this.transport.initBlob(this.options.vaultId, {
        hash: plan.hash,
        size: plan.size,
        chunkCount: plan.chunkCount,
        cipherAlg: plan.cipherAlg
      });

      const missing = new Set(init.missingIndices);
      for (const chunk of plan.chunks) {
        if (missing.size > 0 && !missing.has(chunk.index)) {
          continue;
        }

        await this.transport.uploadBlobChunk(this.options.vaultId, plan.hash, chunk.index, {
          chunkHash: chunk.chunkHash,
          size: chunk.size,
          cipherTextBase64: chunk.cipherTextBase64
        });
      }

      await this.transport.commitBlob(this.options.vaultId, plan.hash, plan.chunkCount, plan.size);

      const op = this.opBuilder.fromVaultEvent(
        {
          ...event,
          content: undefined
        },
        undefined
      );

      return {
        ...op,
        opType: "blob_ref",
        payload: {
          path: event.path,
          blobHash: plan.hash,
          chunkCount: plan.chunkCount,
          size: plan.size,
          cipherAlg: plan.cipherAlg,
          ivBase64: plan.ivBase64,
          authTagBase64: plan.authTagBase64,
          timestamp: event.timestamp
        }
      };
    }

    return this.opBuilder.fromVaultEvent(event, undefined);
  }

  async flushOutbox(): Promise<void> {
    const pending = this.stateStore.peekOutbox(this.maxBatchSize);
    if (pending.length === 0) {
      return;
    }

    const cursor = this.stateStore.getCursor(this.options.vaultId);

    try {
      const response = await this.transport.push(this.options.vaultId, {
        deviceId: this.options.deviceId,
        cursor,
        ops: pending
      });

      await this.stateStore.ackOutbox(pending.map((op) => op.idempotencyKey));
      await this.stateStore.setCursor(this.options.vaultId, response.acknowledgedSeq);
      this.telemetry.track("flush_outbox_success", "info", {
        appliedCount: response.appliedCount,
        acknowledgedSeq: response.acknowledgedSeq
      });
    } catch (error) {
      this.telemetry.track("flush_outbox_failed", "warn", {
        error: String(error)
      });
      await this.retryWithBackoff();
    }
  }

  async pullOnce(): Promise<void> {
    const since = this.stateStore.getCursor(this.options.vaultId);
    const response = await this.transport.pull(this.options.vaultId, since, this.options.deviceId);

    for (const op of response.ops) {
      await this.applyRemoteOp(op.opType, op.payload);
    }

    await this.stateStore.setCursor(this.options.vaultId, response.watermark);
  }

  startRealtime(): void {
    if (
      this.realtimeSocket &&
      (this.realtimeSocket.readyState === WebSocket.OPEN ||
        this.realtimeSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.realtimeSocket = null;
    const since = this.stateStore.getCursor(this.options.vaultId);
    this.realtimeSocket = this.transport.openRealtime(this.options.vaultId, since, {
      onMessage: async (payload) => {
        if (isRealtimeEvent(payload)) {
          const typedPayload = payload;
          await this.applyRemoteOp(typedPayload.opType, typedPayload.payload);
          await this.stateStore.setCursor(this.options.vaultId, typedPayload.seq);
        }
      },
      onOpen: () => {
        this.options.onRealtimeOpen?.();
      },
      onClose: () => {
        this.realtimeSocket = null;
        this.options.onRealtimeClose?.();
      },
      onError: () => {
        this.telemetry.track("realtime_socket_error", "warn");
        this.options.onRealtimeError?.();
      }
    });
  }

  stopRealtime(): void {
    if (!this.realtimeSocket) {
      return;
    }
    this.realtimeSocket.close();
    this.realtimeSocket = null;
  }

  isRealtimeConnected(): boolean {
    return this.realtimeSocket?.readyState === WebSocket.OPEN;
  }

  private async bootstrapKeys(): Promise<void> {
    if (!this.options.devicePublicKeyPem || !this.options.devicePrivateKeyPem) {
      return;
    }

    await this.transport.registerDevice(this.options.vaultId, {
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName ?? `Obsidian-${this.options.deviceId.slice(0, 8)}`,
      publicKey: this.options.devicePublicKeyPem
    });

    const envelopes = await this.transport.getKeyEnvelopes(this.options.vaultId, this.options.deviceId);
    const latestEnvelope = envelopes.reduce((acc, current) =>
      current.version > acc.version ? current : acc
    , envelopes[0]);

    if (latestEnvelope) {
      const vaultKey = decryptVaultKeyForDevice(
        latestEnvelope.encryptedVaultKey,
        this.options.devicePrivateKeyPem
      );
      await this.stateStore.setVaultKey(this.options.vaultId, vaultKey.toString("base64"));
      return;
    }

    const existing = this.stateStore.getVaultKey(this.options.vaultId);
    const generated = existing ? Buffer.from(existing, "base64") : generateVaultKey();
    await this.stateStore.setVaultKey(this.options.vaultId, generated.toString("base64"));

    try {
      const encryptedVaultKey = encryptVaultKeyForDevice(generated, this.options.devicePublicKeyPem);
      await this.transport.rotateKeys(this.options.vaultId, 1, [
        {
          deviceId: this.options.deviceId,
          encryptedVaultKey
        }
      ]);
    } catch (error) {
      this.telemetry.track("vault_key_envelope_publish_failed", "warn", {
        error: String(error)
      });
    }
  }

  private async ensureVaultKey(): Promise<Buffer> {
    const existing = this.stateStore.getVaultKey(this.options.vaultId);
    if (existing) {
      return Buffer.from(existing, "base64");
    }

    const generated = generateVaultKey();
    await this.stateStore.setVaultKey(this.options.vaultId, generated.toString("base64"));
    return generated;
  }

  private async retryWithBackoff(): Promise<void> {
    const baseMs = 300;
    const jitterMs = Math.floor(Math.random() * 100);
    const waitMs = baseMs + jitterMs;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async applyRemoteOp(opType: string, payload: Record<string, unknown>): Promise<void> {
    if (opType === "md_update") {
      const path = String(payload.path ?? "");
      const update = String(payload.yUpdateBase64 ?? "");
      if (!path || !update) {
        return;
      }

      const content = this.crdtEngine.mergeRemoteUpdate(path, update);
      await this.options.onRemoteMarkdown?.(path, content);
      return;
    }

    if (opType === "file_create") {
      const path = String(payload.path ?? "");
      if (!path) {
        return;
      }

      const content = typeof payload.content === "string" ? payload.content : undefined;
      await this.options.onRemoteFileCreate?.(path, content);
      return;
    }

    if (opType === "file_rename") {
      const oldPath = String(payload.oldPath ?? "");
      const newPath = String(payload.path ?? "");
      if (!oldPath || !newPath) {
        return;
      }

      await this.options.onRemoteFileRename?.(oldPath, newPath);
      return;
    }

    if (opType === "file_delete") {
      const path = String(payload.path ?? "");
      if (!path) {
        return;
      }

      await this.options.onRemoteFileDelete?.(path);
      return;
    }

    if (opType === "blob_ref") {
      const path = String(payload.path ?? "");
      const blobHash = String(payload.blobHash ?? "");
      const ivBase64 = String(payload.ivBase64 ?? "");
      const authTagBase64 = String(payload.authTagBase64 ?? "");
      if (!path || !blobHash || !ivBase64 || !authTagBase64) {
        return;
      }

      const manifest = await this.transport.getBlobManifest(this.options.vaultId, blobHash);
      const orderedChunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
      const encryptedParts: Buffer[] = [];
      for (const chunk of orderedChunks) {
        encryptedParts.push(await this.transport.getBlobChunk(this.options.vaultId, blobHash, chunk.index));
      }

      const encryptedBlob = Buffer.concat(encryptedParts);
      const vaultKey = await this.ensureVaultKey();
      const raw = this.blobEngine.decryptBlob(encryptedBlob, vaultKey, ivBase64, authTagBase64);
      await this.options.onRemoteBinaryFile?.(path, raw);
    }
  }
}

function isRealtimeEvent(
  payload: unknown
): payload is { type: "event"; seq: number; payload: Record<string, unknown>; opType: string } {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const value = payload as Record<string, unknown>;
  return (
    value.type === "event" &&
    typeof value.seq === "number" &&
    typeof value.opType === "string" &&
    typeof value.payload === "object" &&
    value.payload !== null
  );
}
