import { describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./syncEngine.js";
import { SyncStateStore } from "./state-store/stateStore.js";
import { YjsMarkdownEngine } from "./crdt-engine/yjsEngine.js";
import { TelemetryClient } from "./telemetry/telemetryClient.js";
import { BlobSyncEngine } from "./blob-engine/blobSyncEngine.js";

describe("SyncEngine integration", () => {
  it("applies remote file create/rename/delete ops", async () => {
    const onRemoteFileCreate = vi.fn();
    const onRemoteFileRename = vi.fn();
    const onRemoteFileDelete = vi.fn();

    const transport = {
      pull: vi.fn().mockResolvedValue({
        watermark: 3,
        ops: [
          {
            seq: 1,
            vaultId: "11111111-1111-4111-8111-111111111111",
            fileId: null,
            opType: "file_create",
            payload: { path: "a.md", content: "hello" },
            createdAt: "2026-01-01T00:00:00.000Z"
          },
          {
            seq: 2,
            vaultId: "11111111-1111-4111-8111-111111111111",
            fileId: null,
            opType: "file_rename",
            payload: { oldPath: "a.md", path: "b.md" },
            createdAt: "2026-01-01T00:00:01.000Z"
          },
          {
            seq: 3,
            vaultId: "11111111-1111-4111-8111-111111111111",
            fileId: null,
            opType: "file_delete",
            payload: { path: "b.md" },
            createdAt: "2026-01-01T00:00:02.000Z"
          }
        ]
      }),
      push: vi.fn(),
      openRealtime: vi.fn(),
      registerDevice: vi.fn(),
      getKeyEnvelopes: vi.fn(),
      initBlob: vi.fn(),
      uploadBlobChunk: vi.fn(),
      commitBlob: vi.fn(),
      getBlobManifest: vi.fn(),
      getBlobChunk: vi.fn()
    };

    const engine = new SyncEngine(
      {
        vaultId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        onRemoteFileCreate,
        onRemoteFileRename,
        onRemoteFileDelete
      },
      transport as never,
      new SyncStateStore(),
      new YjsMarkdownEngine(),
      new TelemetryClient(false)
    );

    await engine.initialize();
    await engine.pullOnce();

    expect(onRemoteFileCreate).toHaveBeenCalledWith("a.md", "hello");
    expect(onRemoteFileRename).toHaveBeenCalledWith("a.md", "b.md");
    expect(onRemoteFileDelete).toHaveBeenCalledWith("b.md");
  });

  it("uploads non-markdown modify events as blob_ref", async () => {
    const pushedOps: unknown[] = [];
    const uploadCalls: Array<{ blobHash: string; index: number }> = [];

    const transport = {
      pull: vi.fn().mockResolvedValue({ watermark: 0, ops: [] }),
      push: vi.fn().mockImplementation(async (_vaultId: string, payload: { ops: unknown[] }) => {
        pushedOps.push(...payload.ops);
        return {
          acknowledgedSeq: 1,
          appliedCount: payload.ops.length,
          missingChunks: [],
          rebaseRequired: false
        };
      }),
      openRealtime: vi.fn(),
      registerDevice: vi.fn(),
      getKeyEnvelopes: vi.fn().mockResolvedValue([]),
      rotateKeys: vi.fn().mockResolvedValue(undefined),
      initBlob: vi.fn().mockResolvedValue({ missingIndices: [0] }),
      uploadBlobChunk: vi.fn().mockImplementation(async (_vaultId: string, blobHash: string, index: number) => {
        uploadCalls.push({ blobHash, index });
      }),
      commitBlob: vi.fn().mockResolvedValue(undefined),
      getBlobManifest: vi.fn(),
      getBlobChunk: vi.fn()
    };

    const engine = new SyncEngine(
      {
        vaultId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222"
      },
      transport as never,
      new SyncStateStore(),
      new YjsMarkdownEngine(),
      new TelemetryClient(false)
    );

    await engine.initialize();
    await engine.handleVaultEvent({
      type: "modify",
      path: "image.png",
      timestamp: "2026-01-01T00:00:00.000Z",
      binaryContentBase64: Buffer.from("binary-data").toString("base64")
    });

    expect(uploadCalls.length).toBeGreaterThan(0);
    expect(pushedOps).toHaveLength(1);
    expect((pushedOps[0] as { opType: string }).opType).toBe("blob_ref");
  });

  it("downloads and decrypts blob_ref operations", async () => {
    const raw = Buffer.from("remote-binary-data");
    const key = Buffer.alloc(32, 7);
    const plan = new BlobSyncEngine().planUpload(raw, key, 4);
    const received: Buffer[] = [];

    const transport = {
      pull: vi.fn().mockResolvedValue({
        watermark: 1,
        ops: [
          {
            seq: 1,
            vaultId: "11111111-1111-4111-8111-111111111111",
            fileId: null,
            opType: "blob_ref",
            payload: {
              path: "bin/file.bin",
              blobHash: plan.hash,
              ivBase64: plan.ivBase64,
              authTagBase64: plan.authTagBase64
            },
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      }),
      push: vi.fn(),
      openRealtime: vi.fn(),
      registerDevice: vi.fn(),
      getKeyEnvelopes: vi.fn(),
      initBlob: vi.fn(),
      uploadBlobChunk: vi.fn(),
      commitBlob: vi.fn(),
      getBlobManifest: vi.fn().mockResolvedValue({
        hash: plan.hash,
        size: plan.size,
        chunkCount: plan.chunkCount,
        cipherAlg: plan.cipherAlg,
        chunks: plan.chunks.map((chunk) => ({
          index: chunk.index,
          chunkHash: chunk.chunkHash,
          size: chunk.size
        }))
      }),
      getBlobChunk: vi.fn().mockImplementation(async (_vaultId: string, _hash: string, index: number) => {
        return Buffer.from(plan.chunks[index].cipherTextBase64, "base64");
      })
    };

    const stateStore = new SyncStateStore();
    await stateStore.setVaultKey("11111111-1111-4111-8111-111111111111", key.toString("base64"));

    const engine = new SyncEngine(
      {
        vaultId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        onRemoteBinaryFile: async (_path, content) => {
          received.push(content);
        }
      },
      transport as never,
      stateStore,
      new YjsMarkdownEngine(),
      new TelemetryClient(false)
    );

    await engine.initialize();
    await engine.pullOnce();

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe(raw.toString());
  });
});
