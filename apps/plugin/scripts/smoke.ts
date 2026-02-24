import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { SyncEngine } from "../src/syncEngine.js";
import { SyncTransport } from "../src/transport/syncTransport.js";
import { SyncStateStore } from "../src/state-store/stateStore.js";
import { JsonFileSyncStatePersistence } from "../src/state-store/filePersistence.js";
import { YjsMarkdownEngine } from "../src/crdt-engine/yjsEngine.js";
import { TelemetryClient } from "../src/telemetry/telemetryClient.js";
import { VaultEventCapture } from "../src/event-capture/vaultEventCapture.js";

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    throw new Error(`login failed (${response.status})`);
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error("login response missing token");
  }
  return body.token;
}

async function ensureVault(baseUrl: string, token: string, preferredName: string): Promise<string> {
  const listResponse = await fetch(`${baseUrl}/v1/vaults`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!listResponse.ok) {
    throw new Error(`list vaults failed (${listResponse.status})`);
  }
  const list = (await listResponse.json()) as Array<{ id: string; name: string }>;
  const existing = list.find((entry) => entry.name === preferredName);
  if (existing) {
    return existing.id;
  }

  const createResponse = await fetch(`${baseUrl}/v1/vaults`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: preferredName })
  });
  if (!createResponse.ok) {
    throw new Error(`create vault failed (${createResponse.status})`);
  }

  const created = (await createResponse.json()) as { id: string };
  return created.id;
}

async function main(): Promise<void> {
  const baseUrl = process.env.OBSYNC_BASE_URL ?? "http://localhost:8080";
  const email = process.env.OBSYNC_EMAIL ?? "user@example.com";
  const password = process.env.OBSYNC_PASSWORD ?? "secret";
  const token = process.env.OBSYNC_TOKEN ?? (await login(baseUrl, email, password));
  const vaultId = process.env.OBSYNC_VAULT_ID ?? (await ensureVault(baseUrl, token, "Smoke Vault"));

  const deviceId = uuidv4();
  const syncTransport = new SyncTransport({ baseUrl, token });
  const stateStore = new SyncStateStore(
    new JsonFileSyncStatePersistence(join(process.cwd(), ".obsync-data", "smoke-state.json"))
  );
  const syncEngine = new SyncEngine(
    {
      vaultId,
      deviceId
    },
    syncTransport,
    stateStore,
    new YjsMarkdownEngine(),
    new TelemetryClient(true)
  );

  await syncEngine.initialize();

  const vaultDir = join(process.cwd(), ".obsync-data", "smoke-vault");
  await mkdir(vaultDir, { recursive: true });
  const notePath = join(vaultDir, "smoke.md");
  const content = `# Obsync smoke\n\nupdated ${new Date().toISOString()}\n`;
  await writeFile(notePath, content, "utf8");

  const eventCapture = new VaultEventCapture();
  const unsubscribe = eventCapture.onEvent((event) => {
    void syncEngine.handleVaultEvent(event);
  });

  eventCapture.emit({
    type: "modify",
    path: "smoke.md",
    timestamp: new Date().toISOString(),
    content
  });

  await new Promise((resolve) => setTimeout(resolve, 250));
  await syncEngine.pullOnce();

  const pulled = await syncTransport.pull(vaultId, 0, deviceId);

  unsubscribe();
  syncEngine.stopRealtime();

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        vaultId,
        deviceId,
        cursor: stateStore.getCursor(vaultId),
        pulledOps: pulled.ops.length,
        lastOp: pulled.ops[pulled.ops.length - 1] ?? null
      },
      null,
      2
    )
  );
}

await main();
