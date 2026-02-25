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

function isWeakJwtSecret(secret: string): boolean {
  const trimmed = secret.trim();
  return trimmed.length < 32 || trimmed === "change-me" || trimmed === "changeme";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "8080");
  if (Number.isNaN(port)) {
    throw new Error("PORT must be a number");
  }

  const nodeEnv = env.NODE_ENV ?? "development";
  const jwtSecret = env.JWT_SECRET ?? "change-me";
  if (nodeEnv === "production" && isWeakJwtSecret(jwtSecret)) {
    throw new Error("JWT_SECRET is too weak for production (minimum 32 chars and not default)");
  }

  return {
    nodeEnv,
    port,
    jwtSecret,
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
