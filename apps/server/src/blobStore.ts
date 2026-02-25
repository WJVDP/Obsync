import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStore {
  writeChunk(blobHash: string, index: number, raw: Buffer): Promise<string>;
  readChunk(storageKey: string): Promise<Buffer>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  async writeChunk(blobHash: string, index: number, raw: Buffer): Promise<string> {
    const blobDir = join(this.rootDir, "blobs", blobHash);
    await mkdir(blobDir, { recursive: true });
    const storageKey = join(blobDir, `${index}.bin`);
    await writeFile(storageKey, raw);
    return storageKey;
  }

  async readChunk(storageKey: string): Promise<Buffer> {
    return readFile(storageKey);
  }
}
