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

export interface DeviceRegisterRequest {
  deviceId: string;
  deviceName: string;
  publicKey: string;
}

export interface KeyEnvelopePayload {
  deviceId: string;
  version: number;
  encryptedVaultKey: string;
}

export interface BlobManifestResponse {
  hash: string;
  size: number;
  chunkCount: number;
  cipherAlg: string;
  chunks: Array<{
    index: number;
    chunkHash: string;
    size: number;
  }>;
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

  async registerDevice(vaultId: string, request: DeviceRegisterRequest): Promise<void> {
    await this.request<{ id: string }>(`/v1/vaults/${vaultId}/devices/register`, {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  async getKeyEnvelopes(vaultId: string, deviceId: string): Promise<KeyEnvelopePayload[]> {
    const params = new URLSearchParams({ deviceId });
    const response = await this.request<{ envelopes?: KeyEnvelopePayload[] }>(
      `/v1/vaults/${vaultId}/keys?${params.toString()}`
    );
    return response.envelopes ?? [];
  }

  async rotateKeys(
    vaultId: string,
    version: number,
    envelopes: Array<{ deviceId: string; encryptedVaultKey: string }>
  ): Promise<void> {
    await this.request<{ updated: number }>(`/v1/vaults/${vaultId}/keys/rotate`, {
      method: "POST",
      body: JSON.stringify({ version, envelopes })
    });
  }

  async initBlob(
    vaultId: string,
    payload: { hash: string; size: number; chunkCount: number; cipherAlg: string }
  ): Promise<{ missingIndices: number[] }> {
    return this.request<{ missingIndices: number[] }>(`/v1/vaults/${vaultId}/blobs/init`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async uploadBlobChunk(
    vaultId: string,
    blobHash: string,
    index: number,
    payload: { chunkHash: string; size: number; cipherTextBase64: string }
  ): Promise<void> {
    await this.request<{ persisted: boolean }>(
      `/v1/vaults/${vaultId}/blobs/${blobHash}/chunks/${index}`,
      {
        method: "PUT",
        body: JSON.stringify(payload)
      }
    );
  }

  async commitBlob(
    vaultId: string,
    blobHash: string,
    expectedChunkCount: number,
    expectedSize: number
  ): Promise<void> {
    await this.request<{ committed: boolean }>(`/v1/vaults/${vaultId}/blobs/${blobHash}/commit`, {
      method: "POST",
      body: JSON.stringify({
        hash: blobHash,
        expectedChunkCount,
        expectedSize
      })
    });
  }

  async getBlobManifest(vaultId: string, blobHash: string): Promise<BlobManifestResponse> {
    return this.request<BlobManifestResponse>(`/v1/vaults/${vaultId}/blobs/${blobHash}`);
  }

  async getBlobChunk(vaultId: string, blobHash: string, index: number): Promise<Buffer> {
    const response = await this.request<{
      cipherTextBase64: string;
      chunkHash: string;
      size: number;
    }>(`/v1/vaults/${vaultId}/blobs/${blobHash}/chunks/${index}`);
    return Buffer.from(response.cipherTextBase64, "base64");
  }

  openRealtime(
    vaultId: string,
    since: number,
    handlers: RealtimeHandlers
  ): WebSocket {
    const endpoint = this.options.baseUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({
      since: String(since)
    });
    const socket = new WebSocket(
      `${endpoint}/v1/vaults/${vaultId}/realtime?${params.toString()}`,
      ["obsync-auth", this.options.token]
    );

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
