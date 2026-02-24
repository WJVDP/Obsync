import { chunkBuffer, encryptPayload, generateVaultKey, sha256Hex } from "@obsync/shared";

export interface BlobChunkUpload {
  index: number;
  chunkHash: string;
  size: number;
  cipherTextBase64: string;
}

export interface BlobUploadPlan {
  hash: string;
  size: number;
  chunkCount: number;
  chunks: BlobChunkUpload[];
}

export class BlobSyncEngine {
  planUpload(rawData: Buffer, chunkSizeBytes = 1024 * 1024): BlobUploadPlan {
    const vaultKey = generateVaultKey();
    const encrypted = encryptPayload(rawData, vaultKey);
    const encryptedBuffer = Buffer.from(encrypted.cipherTextBase64, "base64");

    const chunks = chunkBuffer(encryptedBuffer, chunkSizeBytes).map((chunk) => ({
      index: chunk.index,
      chunkHash: chunk.hash,
      size: chunk.data.length,
      cipherTextBase64: chunk.data.toString("base64")
    }));

    return {
      hash: sha256Hex(encryptedBuffer),
      size: encryptedBuffer.length,
      chunkCount: chunks.length,
      chunks
    };
  }
}
