import { EventEmitter } from "node:events";

export interface RealtimeEvent {
  vaultId: string;
  seq: number;
  opType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class RealtimeBus {
  private readonly emitter = new EventEmitter();

  publish(event: RealtimeEvent): void {
    this.emitter.emit(`vault:${event.vaultId}`, event);
  }

  subscribe(vaultId: string, listener: (event: RealtimeEvent) => void): () => void {
    const eventName = `vault:${vaultId}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }
}
