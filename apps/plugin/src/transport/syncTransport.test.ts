import { describe, expect, it } from "vitest";
import { SyncTransport } from "./syncTransport.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  addEventListener(): void {
    // no-op for constructor contract testing
  }
}

describe("SyncTransport.openRealtime", () => {
  it("uses websocket protocol for auth token and does not add token query parameter", () => {
    const original = globalThis.WebSocket;
    MockWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket as unknown;

    try {
      const transport = new SyncTransport({
        baseUrl: "http://localhost:8080",
        token: "secret-token"
      });

      transport.openRealtime("11111111-1111-4111-8111-111111111111", 7, {
        onMessage: () => {
          return;
        }
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      const socket = MockWebSocket.instances[0];
      expect(socket.url).toContain("ws://localhost:8080/v1/vaults/11111111-1111-4111-8111-111111111111/realtime?since=7");
      expect(socket.url).not.toContain("token=");
      expect(socket.protocols).toEqual(["obsync-auth", "secret-token"]);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  });
});
