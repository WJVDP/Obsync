export type VaultEventType = "create" | "modify" | "delete" | "rename";

export interface VaultEvent {
  type: VaultEventType;
  path: string;
  oldPath?: string;
  timestamp: string;
  content?: string;
  binaryContentBase64?: string;
}

export type VaultEventListener = (event: VaultEvent) => void;

export class VaultEventCapture {
  private listeners: VaultEventListener[] = [];

  onEvent(listener: VaultEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  emit(event: VaultEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
