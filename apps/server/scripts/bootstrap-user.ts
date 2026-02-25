import { createPool, one, runMigrations } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { hashPassword } from "../src/password.js";

async function bootstrapUser(): Promise<void> {
  const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_PASSWORD ?? "";

  if (!email || !password) {
    throw new Error("BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD are required");
  }

  if (password.length < 12) {
    throw new Error("BOOTSTRAP_PASSWORD must be at least 12 characters");
  }

  const config = readConfig();
  const pool = createPool(config.databaseUrl);

  try {
    await runMigrations(pool);

    const existingUsers = await one<{ count: string }>(pool, "SELECT count(*)::text AS count FROM users");
    const count = Number(existingUsers?.count ?? 0);
    if (count > 0) {
      throw new Error("Bootstrap denied: at least one user already exists");
    }

    const passwordHash = hashPassword(password);
    const user = await one<{ id: string; email: string }>(
      pool,
      `INSERT INTO users(email, password_hash)
       VALUES($1, $2)
       RETURNING id, email`,
      [email, passwordHash]
    );

    if (!user) {
      throw new Error("Failed to create bootstrap user");
    }

    console.log(JSON.stringify({ ok: true, userId: user.id, email: user.email }, null, 2));
  } finally {
    await pool.end();
  }
}

void bootstrapUser().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
