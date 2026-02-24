import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResultRow } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function runMigrations(pool: Pool): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDir, "migrations.sql"),
    join(currentDir, "../src/migrations.sql"),
    join(process.cwd(), "apps/server/src/migrations.sql")
  ];

  let sql: string | null = null;
  for (const candidate of candidates) {
    try {
      sql = await readFile(candidate, "utf8");
      break;
    } catch (error) {
      const message = String(error);
      if (!message.includes("ENOENT")) {
        throw error;
      }
    }
  }

  if (!sql) {
    throw new Error(`Unable to locate migrations.sql. Tried: ${candidates.join(", ")}`);
  }

  await pool.query(sql);
}

export async function one<T extends QueryResultRow>(
  pool: Pool,
  queryText: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await pool.query<T>(queryText, values);
  return result.rows[0] ?? null;
}

export async function many<T extends QueryResultRow>(
  pool: Pool,
  queryText: string,
  values: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(queryText, values);
  return result.rows;
}
