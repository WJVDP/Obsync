export interface AppConfig {
  nodeEnv: string;
  port: number;
  jwtSecret: string;
  databaseUrl: string;
  dataDir: string;
  blobStoreMode: "filesystem" | "minio";
  minioEndpoint: string;
  minioBucket: string;
  minioAccessKey: string;
  minioSecretKey: string;
  minioRegion: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "8080");
  if (Number.isNaN(port)) {
    throw new Error("PORT must be a number");
  }

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port,
    jwtSecret: env.JWT_SECRET ?? "change-me",
    databaseUrl: env.DATABASE_URL ?? "postgres://obsync:obsync@localhost:5432/obsync",
    dataDir: env.DATA_DIR ?? "apps/server/data",
    blobStoreMode: (env.BLOB_STORE_MODE as "filesystem" | "minio" | undefined) ?? "filesystem",
    minioEndpoint: env.MINIO_ENDPOINT ?? "http://localhost:9000",
    minioBucket: env.MINIO_BUCKET ?? "obsync-blobs",
    minioAccessKey: env.MINIO_ACCESS_KEY ?? "minioadmin",
    minioSecretKey: env.MINIO_SECRET_KEY ?? "minioadmin",
    minioRegion: env.MINIO_REGION ?? "us-east-1"
  };
}
