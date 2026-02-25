import { chunkBuffer, decryptPayload, encryptPayload, sha256Hex } from "@obsync/shared";

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
  cipherAlg: string;
  ivBase64: string;
  authTagBase64: string;
  chunks: BlobChunkUpload[];
}

export class BlobSyncEngine {
  planUpload(rawData: Buffer, vaultKey: Buffer, chunkSizeBytes = 1024 * 1024): BlobUploadPlan {
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
      cipherAlg: "AES-256-GCM",
      ivBase64: encrypted.ivBase64,
      authTagBase64: encrypted.authTagBase64,
      chunks
    };
  }

  decryptBlob(
    encryptedBlob: Buffer,
    vaultKey: Buffer,
    ivBase64: string,
    authTagBase64: string
  ): Buffer {
    return decryptPayload(
      {
        ivBase64,
        authTagBase64,
        cipherTextBase64: encryptedBlob.toString("base64")
      },
      vaultKey
    );
  }
}
