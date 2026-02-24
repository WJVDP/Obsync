import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { BlobStore } from "./blobStore.js";

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly options: {
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    }
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  async writeChunk(blobHash: string, index: number, raw: Buffer): Promise<string> {
    const key = `blobs/${blobHash}/${index}.bin`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: raw,
        ContentType: "application/octet-stream"
      })
    );
    return key;
  }
}
