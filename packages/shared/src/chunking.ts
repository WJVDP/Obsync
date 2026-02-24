import { createHash } from "node:crypto";

export interface Chunk {
  index: number;
  data: Buffer;
  hash: string;
}

export function chunkBuffer(buffer: Buffer, chunkSizeBytes = 1024 * 1024): Chunk[] {
  if (chunkSizeBytes <= 0) {
    throw new Error("chunkSizeBytes must be positive");
  }

  const chunks: Chunk[] = [];
  for (let offset = 0, index = 0; offset < buffer.length; offset += chunkSizeBytes, index += 1) {
    const data = buffer.subarray(offset, Math.min(offset + chunkSizeBytes, buffer.length));
    chunks.push({
      index,
      data,
      hash: createHash("sha256").update(data).digest("hex")
    });
  }

  return chunks;
}

export function joinChunks(chunks: Pick<Chunk, "index" | "data">[]): Buffer {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  return Buffer.concat(ordered.map((chunk) => chunk.data));
}
