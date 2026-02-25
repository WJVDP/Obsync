import type { SyncBatchPushRequest, SyncBatchPushResponse, PullResponse } from "@obsync/shared";

export interface SyncTransportOptions {
  baseUrl: string;
  token: string;
}

export interface RealtimeHandlers {
  onMessage: (payload: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
}

export class SyncTransport {
  constructor(private readonly options: SyncTransportOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }

  async push(vaultId: string, request: SyncBatchPushRequest): Promise<SyncBatchPushResponse> {
    return this.request<SyncBatchPushResponse>(`/v1/vaults/${vaultId}/sync/push`, {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  async pull(vaultId: string, since: number, deviceId: string): Promise<PullResponse> {
    const params = new URLSearchParams({ since: String(since), deviceId });
    return this.request<PullResponse>(`/v1/vaults/${vaultId}/sync/pull?${params.toString()}`);
  }

  openRealtime(
    vaultId: string,
    since: number,
    handlers: RealtimeHandlers
  ): WebSocket {
    const endpoint = this.options.baseUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({
      since: String(since),
      token: this.options.token
    });
    const socket = new WebSocket(`${endpoint}/v1/vaults/${vaultId}/realtime?${params.toString()}`);

    socket.addEventListener("message", (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)));
      } catch {
        handlers.onMessage(event.data);
      }
    });

    socket.addEventListener("open", () => handlers.onOpen?.());
    socket.addEventListener("close", () => handlers.onClose?.());
    socket.addEventListener("error", (event) => handlers.onError?.(event));

    return socket;
  }
}
