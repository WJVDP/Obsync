import type { SyncOp } from "@obsync/shared";
import type { VaultEvent } from "./event-capture/vaultEventCapture.js";
import { SyncOpBuilder } from "./op-builder/syncOpBuilder.js";
import { SyncStateStore } from "./state-store/stateStore.js";
import { SyncTransport } from "./transport/syncTransport.js";
import { TelemetryClient } from "./telemetry/telemetryClient.js";
import { YjsMarkdownEngine } from "./crdt-engine/yjsEngine.js";

export interface SyncEngineOptions {
  vaultId: string;
  deviceId: string;
  maxBatchSize?: number;
  onRemoteMarkdown?: (path: string, content: string) => Promise<void> | void;
}

export class SyncEngine {
  private readonly maxBatchSize: number;
  private realtimeSocket: WebSocket | null = null;
  private readonly opBuilder: SyncOpBuilder;

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
  }

  async handleVaultEvent(event: VaultEvent): Promise<void> {
    const op = this.buildOperation(event);
    await this.stateStore.addOutboxOps([op]);
    await this.flushOutbox();
  }

  private buildOperation(event: VaultEvent): SyncOp {
    if (event.type === "modify" && event.path.endsWith(".md") && event.content !== undefined) {
      const snapshot = this.crdtEngine.applyText(event.path, event.content);
      const op = this.opBuilder.fromVaultEvent({
        ...event,
        content: undefined
      }, undefined);
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
    if (this.realtimeSocket) {
      return;
    }

    const since = this.stateStore.getCursor(this.options.vaultId);
    this.realtimeSocket = this.transport.openRealtime(
      this.options.vaultId,
      since,
      async (payload) => {
        if (isRealtimeEvent(payload)) {
          const typedPayload = payload;
          await this.applyRemoteOp(typedPayload.opType, typedPayload.payload);
          await this.stateStore.setCursor(this.options.vaultId, typedPayload.seq);
        }
      },
      () => {
        this.telemetry.track("realtime_socket_error", "warn");
      }
    );
  }

  stopRealtime(): void {
    if (!this.realtimeSocket) {
      return;
    }
    this.realtimeSocket.close();
    this.realtimeSocket = null;
  }

  private async retryWithBackoff(): Promise<void> {
    const baseMs = 300;
    const jitterMs = Math.floor(Math.random() * 100);
    const waitMs = baseMs + jitterMs;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async applyRemoteOp(opType: string, payload: Record<string, unknown>): Promise<void> {
    if (opType !== "md_update") {
      return;
    }

    const path = String(payload.path ?? "");
    const update = String(payload.yUpdateBase64 ?? "");
    if (!path || !update) {
      return;
    }

    const content = this.crdtEngine.mergeRemoteUpdate(path, update);
    await this.options.onRemoteMarkdown?.(path, content);
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
