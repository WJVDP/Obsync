import type { SyncOp } from "@obsync/shared";

export interface KeyEnvelope {
  deviceId: string;
  version: number;
  encryptedVaultKey: string;
}

export interface SyncStateSnapshot {
  outbox: SyncOp[];
  cursors: Record<string, number>;
  keyEnvelopes: Record<string, KeyEnvelope[]>;
}

export interface SyncStatePersistence {
  load(): Promise<SyncStateSnapshot | null>;
  save(snapshot: SyncStateSnapshot): Promise<void>;
}

export class SyncStateStore {
  private outbox: SyncOp[] = [];
  private cursors = new Map<string, number>();
  private keyEnvelopes = new Map<string, KeyEnvelope[]>();

  constructor(private readonly persistence?: SyncStatePersistence) {}

  async load(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const snapshot = await this.persistence.load();
    if (!snapshot) {
      return;
    }

    this.outbox = snapshot.outbox ?? [];
    this.cursors = new Map(Object.entries(snapshot.cursors ?? {}));
    this.keyEnvelopes = new Map(Object.entries(snapshot.keyEnvelopes ?? {}));
  }

  private async persist(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    await this.persistence.save({
      outbox: this.outbox,
      cursors: Object.fromEntries(this.cursors.entries()),
      keyEnvelopes: Object.fromEntries(this.keyEnvelopes.entries())
    });
  }

  async addOutboxOps(ops: SyncOp[]): Promise<void> {
    this.outbox.push(...ops);
    await this.persist();
  }

  peekOutbox(limit = 100): SyncOp[] {
    return this.outbox.slice(0, limit);
  }

  async ackOutbox(idempotencyKeys: string[]): Promise<void> {
    const acknowledged = new Set(idempotencyKeys);
    this.outbox = this.outbox.filter((op) => !acknowledged.has(op.idempotencyKey));
    await this.persist();
  }

  async setCursor(vaultId: string, seq: number): Promise<void> {
    this.cursors.set(vaultId, seq);
    await this.persist();
  }

  getCursor(vaultId: string): number {
    return this.cursors.get(vaultId) ?? 0;
  }

  async setKeyEnvelopes(vaultId: string, envelopes: KeyEnvelope[]): Promise<void> {
    this.keyEnvelopes.set(vaultId, envelopes);
    await this.persist();
  }

  getKeyEnvelopes(vaultId: string): KeyEnvelope[] {
    return this.keyEnvelopes.get(vaultId) ?? [];
  }
}
