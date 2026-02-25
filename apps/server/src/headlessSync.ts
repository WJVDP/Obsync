import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  PullResponseSchema,
  SyncBatchPushResponseSchema,
  type PullResponse,
  type SyncOp
} from "@obsync/shared";

interface HeadlessState {
  cursor: number;
  deviceId: string;
  logicalClock: number;
  docs: Record<string, string>;
  fileHashes: Record<string, string>;
}

interface LoadedState {
  existed: boolean;
  state: HeadlessState;
}

interface LocalFileSnapshot {
  relativePath: string;
  isMarkdown: boolean;
  content: Buffer;
  hash: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPollIntervalMs(): number {
  const raw = process.env.HEADLESS_POLL_INTERVAL_MS?.trim() ?? "5000";
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 500) {
    throw new Error("HEADLESS_POLL_INTERVAL_MS must be a number >= 500");
  }
  return Math.floor(value);
}

function readLocalPushEnabled(): boolean {
  const raw = process.env.HEADLESS_PUSH_LOCAL_CHANGES?.trim() ?? "1";
  return raw === "1";
}

function readSeedConfig(): { enabled: boolean; sourcePath: string | null } {
  const enabledRaw = process.env.HEADLESS_SEED_SOURCE_ENABLED?.trim() ?? "0";
  const sourceRaw = process.env.HEADLESS_SEED_SOURCE_PATH?.trim() ?? "";
  return {
    enabled: enabledRaw === "1",
    sourcePath: sourceRaw ? resolve(sourceRaw) : null
  };
}

function normalizeVaultRelativePath(rawPath: unknown): string {
  const value = String(rawPath ?? "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!value || value === "." || value.includes("\0")) {
    throw new Error(`Invalid vault path: ${String(rawPath ?? "")}`);
  }
  return value;
}

function resolveWithinMirror(mirrorRoot: string, relativePath: string): string {
  const absolutePath = resolve(mirrorRoot, relativePath);
  if (absolutePath === mirrorRoot) {
    return absolutePath;
  }
  if (!absolutePath.startsWith(`${mirrorRoot}${sep}`)) {
    throw new Error(`Path escapes mirror root: ${relativePath}`);
  }
  return absolutePath;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      return `${error.name}: ${error.message} (cause: ${String(cause)})`;
    }
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneState(state: HeadlessState): HeadlessState {
  return {
    cursor: state.cursor,
    deviceId: state.deviceId,
    logicalClock: state.logicalClock,
    docs: { ...state.docs },
    fileHashes: { ...state.fileHashes }
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function writeBinaryFile(targetPath: string, content: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

async function renameIfExists(fromPath: string, toPath: string): Promise<void> {
  if (!(await exists(fromPath))) {
    return;
  }
  await mkdir(dirname(toPath), { recursive: true });
  await rename(fromPath, toPath);
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

function stateFilePath(mirrorRoot: string): string {
  return join(mirrorRoot, ".obsync-headless-state.json");
}

async function clearMirrorDirectory(mirrorRoot: string): Promise<void> {
  const entries = await readdir(mirrorRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".obsync-headless-state.json") {
      continue;
    }
    await rm(join(mirrorRoot, entry.name), { recursive: true, force: true });
  }
}

async function copyDirectoryRecursive(sourceRoot: string, targetRoot: string): Promise<void> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".obsidian") {
      continue;
    }

    const sourcePath = join(sourceRoot, entry.name);
    const targetPath = join(targetRoot, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      continue;
    }
  }
}

async function seedMirrorFromSource(sourcePath: string, mirrorRoot: string): Promise<void> {
  if (!(await exists(sourcePath))) {
    throw new Error(`Seed source path not found: ${sourcePath}`);
  }

  await clearMirrorDirectory(mirrorRoot);
  await copyDirectoryRecursive(sourcePath, mirrorRoot);
}

async function loadState(mirrorRoot: string): Promise<LoadedState> {
  const path = stateFilePath(mirrorRoot);
  if (!(await exists(path))) {
    return {
      existed: false,
      state: {
        cursor: 0,
        deviceId: randomUUID(),
        logicalClock: 0,
        docs: {},
        fileHashes: {}
      }
    };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<HeadlessState>;
  return {
    existed: true,
    state: {
      cursor: Number.isInteger(parsed.cursor) && parsed.cursor! >= 0 ? parsed.cursor! : 0,
      deviceId:
        typeof parsed.deviceId === "string" && parsed.deviceId.length > 0 ? parsed.deviceId : randomUUID(),
      logicalClock:
        Number.isInteger(parsed.logicalClock) && parsed.logicalClock! >= 0 ? parsed.logicalClock! : 0,
      docs: typeof parsed.docs === "object" && parsed.docs !== null ? (parsed.docs as Record<string, string>) : {},
      fileHashes:
        typeof parsed.fileHashes === "object" && parsed.fileHashes !== null
          ? (parsed.fileHashes as Record<string, string>)
          : {}
    }
  };
}

async function saveState(mirrorRoot: string, state: HeadlessState): Promise<void> {
  const path = stateFilePath(mirrorRoot);
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tmpPath, path);
}

async function pullOnce(
  baseUrl: string,
  vaultId: string,
  token: string,
  since: number,
  deviceId: string
): Promise<PullResponse> {
  const params = new URLSearchParams({
    since: String(since),
    deviceId
  });
  const response = await fetch(`${baseUrl}/v1/vaults/${vaultId}/sync/pull?${params.toString()}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Pull failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as unknown;
  const parsed = PullResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Pull response schema validation failed");
  }

  return parsed.data;
}

async function pushBatch(
  baseUrl: string,
  vaultId: string,
  token: string,
  deviceId: string,
  cursor: number,
  ops: SyncOp[]
): Promise<{ acknowledgedSeq: number }> {
  const response = await fetch(`${baseUrl}/v1/vaults/${vaultId}/sync/push`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      deviceId,
      cursor,
      ops
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Push failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as unknown;
  const parsed = SyncBatchPushResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Push response schema validation failed");
  }

  return {
    acknowledgedSeq: parsed.data.acknowledgedSeq
  };
}

function encodeMarkdownUpdate(content: string): { updateBase64: string; stateVectorBase64: string } {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return {
    updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    stateVectorBase64: Buffer.from(Y.encodeStateVector(doc)).toString("base64")
  };
}

function encodeMarkdownUpdateFromState(
  previousUpdateBase64: string | undefined,
  content: string
): { updateBase64: string; stateVectorBase64: string } {
  const doc = new Y.Doc();
  if (previousUpdateBase64) {
    Y.applyUpdate(doc, Buffer.from(previousUpdateBase64, "base64"));
  }

  const yText = doc.getText("content");
  yText.delete(0, yText.length);
  yText.insert(0, content);

  return {
    updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    stateVectorBase64: Buffer.from(Y.encodeStateVector(doc)).toString("base64")
  };
}

function setMarkdownState(state: HeadlessState, path: string, content: string): void {
  const encoded = encodeMarkdownUpdate(content);
  state.docs[path] = encoded.updateBase64;
  state.fileHashes[path] = hashText(content);
}

function mergeMarkdownUpdate(state: HeadlessState, path: string, updateBase64: string): string {
  const doc = new Y.Doc();
  const existing = state.docs[path];
  if (existing) {
    Y.applyUpdate(doc, Buffer.from(existing, "base64"));
  }

  Y.applyUpdate(doc, Buffer.from(updateBase64, "base64"));
  state.docs[path] = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  const content = doc.getText("content").toString();
  state.fileHashes[path] = hashText(content);
  return content;
}

async function applyRemoteOps(mirrorRoot: string, state: HeadlessState, response: PullResponse): Promise<void> {
  for (const op of response.ops) {
    switch (op.opType) {
      case "md_update": {
        const relativePath = normalizeVaultRelativePath(op.payload.path);
        const updateBase64 = String(op.payload.yUpdateBase64 ?? "");
        if (!updateBase64) {
          throw new Error(`md_update missing yUpdateBase64 for ${relativePath}`);
        }
        const content = mergeMarkdownUpdate(state, relativePath, updateBase64);
        const targetPath = resolveWithinMirror(mirrorRoot, relativePath);
        await writeTextFile(targetPath, content);
        break;
      }
      case "file_create": {
        const relativePath = normalizeVaultRelativePath(op.payload.path);
        const targetPath = resolveWithinMirror(mirrorRoot, relativePath);
        const content =
          typeof op.payload.content === "string"
            ? op.payload.content
            : typeof op.payload.text === "string"
              ? op.payload.text
              : "";
        if (typeof op.payload.binaryContentBase64 === "string" && op.payload.binaryContentBase64.length > 0) {
          const raw = Buffer.from(op.payload.binaryContentBase64, "base64");
          await writeBinaryFile(targetPath, raw);
          state.fileHashes[relativePath] = hashBuffer(raw);
          delete state.docs[relativePath];
        } else {
          await writeTextFile(targetPath, content);
          if (relativePath.endsWith(".md")) {
            setMarkdownState(state, relativePath, content);
          } else {
            state.fileHashes[relativePath] = hashText(content);
          }
        }
        break;
      }
      case "file_rename": {
        const oldRelativePath = normalizeVaultRelativePath(op.payload.oldPath);
        const newRelativePath = normalizeVaultRelativePath(op.payload.path);
        const oldPath = resolveWithinMirror(mirrorRoot, oldRelativePath);
        const newPath = resolveWithinMirror(mirrorRoot, newRelativePath);
        await renameIfExists(oldPath, newPath);
        if (state.docs[oldRelativePath]) {
          state.docs[newRelativePath] = state.docs[oldRelativePath];
          delete state.docs[oldRelativePath];
        }
        if (state.fileHashes[oldRelativePath]) {
          state.fileHashes[newRelativePath] = state.fileHashes[oldRelativePath];
          delete state.fileHashes[oldRelativePath];
        }
        break;
      }
      case "file_delete": {
        const relativePath = normalizeVaultRelativePath(op.payload.path);
        const targetPath = resolveWithinMirror(mirrorRoot, relativePath);
        await removeIfExists(targetPath);
        delete state.docs[relativePath];
        delete state.fileHashes[relativePath];
        break;
      }
      case "blob_ref":
      case "key_rotate": {
        break;
      }
      default: {
        break;
      }
    }
  }
}

async function walkMirrorFiles(
  mirrorRoot: string,
  currentDir: string,
  out: Map<string, LocalFileSnapshot>
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".obsidian") {
      continue;
    }

    const absolutePath = join(currentDir, entry.name);
    const relativePath = normalizeVaultRelativePath(absolutePath.slice(mirrorRoot.length + 1));

    if (relativePath === ".obsync-headless-state.json") {
      continue;
    }

    if (entry.isDirectory()) {
      await walkMirrorFiles(mirrorRoot, absolutePath, out);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const content = await readFile(absolutePath);
    out.set(relativePath, {
      relativePath,
      isMarkdown: relativePath.endsWith(".md"),
      content,
      hash: hashBuffer(content)
    });
  }
}

async function scanMirror(mirrorRoot: string): Promise<Map<string, LocalFileSnapshot>> {
  const out = new Map<string, LocalFileSnapshot>();
  await walkMirrorFiles(mirrorRoot, mirrorRoot, out);
  return out;
}

function makeSyncOp(
  state: HeadlessState,
  path: string,
  opType: SyncOp["opType"],
  payload: Record<string, unknown>
): SyncOp {
  state.logicalClock += 1;
  const logicalClock = state.logicalClock;
  return {
    idempotencyKey: `headless-${state.deviceId}-${logicalClock}-${Date.now()}`,
    deviceId: state.deviceId,
    path,
    opType,
    logicalClock,
    payload,
    createdAt: new Date().toISOString()
  };
}

function buildLocalPushPlan(
  state: HeadlessState,
  scanned: Map<string, LocalFileSnapshot>
): { nextState: HeadlessState; ops: SyncOp[]; skippedNonMarkdown: number } {
  const nextState = cloneState(state);
  const ops: SyncOp[] = [];
  let skippedNonMarkdown = 0;

  for (const previousPath of Object.keys(nextState.fileHashes)) {
    if (!scanned.has(previousPath)) {
      ops.push(makeSyncOp(nextState, previousPath, "file_delete", { path: previousPath }));
      delete nextState.fileHashes[previousPath];
      delete nextState.docs[previousPath];
    }
  }

  for (const file of scanned.values()) {
    const previousHash = nextState.fileHashes[file.relativePath];
    if (previousHash === file.hash) {
      continue;
    }

    if (!file.isMarkdown) {
      nextState.fileHashes[file.relativePath] = file.hash;
      skippedNonMarkdown += 1;
      continue;
    }

    const content = file.content.toString("utf8");
    const encoded = encodeMarkdownUpdateFromState(nextState.docs[file.relativePath], content);
    nextState.docs[file.relativePath] = encoded.updateBase64;
    nextState.fileHashes[file.relativePath] = file.hash;
    ops.push(
      makeSyncOp(nextState, file.relativePath, "md_update", {
        path: file.relativePath,
        yUpdateBase64: encoded.updateBase64,
        stateVectorBase64: encoded.stateVectorBase64
      })
    );
  }

  return { nextState, ops, skippedNonMarkdown };
}

async function pushLocalChanges(
  baseUrl: string,
  vaultId: string,
  token: string,
  mirrorRoot: string,
  state: HeadlessState
): Promise<number> {
  const scanned = await scanMirror(mirrorRoot);
  const { nextState, ops, skippedNonMarkdown } = buildLocalPushPlan(state, scanned);

  if (ops.length === 0) {
    if (skippedNonMarkdown > 0) {
      console.log(
        `[headless-sync] local non-markdown changes detected=${skippedNonMarkdown} (tracked locally, not pushed)`
      );
    }
    state.fileHashes = nextState.fileHashes;
    state.docs = nextState.docs;
    state.logicalClock = nextState.logicalClock;
    await saveState(mirrorRoot, state);
    return 0;
  }

  let cursor = state.cursor;
  let offset = 0;
  const batchSize = 100;

  while (offset < ops.length) {
    const batch = ops.slice(offset, offset + batchSize);
    const result = await pushBatch(baseUrl, vaultId, token, state.deviceId, cursor, batch);
    cursor = result.acknowledgedSeq;
    offset += batch.length;
  }

  state.cursor = cursor;
  state.fileHashes = nextState.fileHashes;
  state.docs = nextState.docs;
  state.logicalClock = nextState.logicalClock;
  await saveState(mirrorRoot, state);

  if (skippedNonMarkdown > 0) {
    console.log(
      `[headless-sync] local markdown pushed=${ops.length}, non-markdown skipped=${skippedNonMarkdown}, cursor=${state.cursor}`
    );
  } else {
    console.log(`[headless-sync] local markdown pushed=${ops.length} cursor=${state.cursor}`);
  }

  return ops.length;
}

async function initializeLocalSnapshot(mirrorRoot: string, state: HeadlessState): Promise<void> {
  const scanned = await scanMirror(mirrorRoot);
  state.fileHashes = {};
  state.docs = {};

  for (const file of scanned.values()) {
    state.fileHashes[file.relativePath] = file.hash;
    if (file.isMarkdown) {
      const content = file.content.toString("utf8");
      const encoded = encodeMarkdownUpdate(content);
      state.docs[file.relativePath] = encoded.updateBase64;
    }
  }

  await saveState(mirrorRoot, state);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pullAndApplyUntilIdle(
  baseUrl: string,
  vaultId: string,
  token: string,
  mirrorRoot: string,
  state: HeadlessState,
  shouldStop: () => boolean
): Promise<number> {
  let totalApplied = 0;

  while (!shouldStop()) {
    const response = await pullOnce(baseUrl, vaultId, token, state.cursor, state.deviceId);
    if (response.ops.length === 0) {
      break;
    }

    await applyRemoteOps(mirrorRoot, state, response);
    state.cursor = response.watermark;
    await saveState(mirrorRoot, state);
    totalApplied += response.ops.length;
    console.log(`[headless-sync] applied=${response.ops.length} cursor=${state.cursor}`);
  }

  return totalApplied;
}

async function main(): Promise<void> {
  const baseUrl = readRequiredEnv("HEADLESS_BASE_URL");
  const vaultId = readRequiredEnv("HEADLESS_VAULT_ID");
  const token = readRequiredEnv("HEADLESS_API_TOKEN");
  const mirrorRoot = resolve(readRequiredEnv("HEADLESS_MIRROR_PATH"));
  const pollIntervalMs = readPollIntervalMs();
  const localPushEnabled = readLocalPushEnabled();
  const seedConfig = readSeedConfig();

  await mkdir(mirrorRoot, { recursive: true });
  const loaded = await loadState(mirrorRoot);
  const state = loaded.state;

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[headless-sync] mirror=${mirrorRoot} vault=${vaultId} base=${baseUrl}`);

  if (!loaded.existed && seedConfig.enabled) {
    if (!seedConfig.sourcePath) {
      throw new Error("HEADLESS_SEED_SOURCE_ENABLED=1 requires HEADLESS_SEED_SOURCE_PATH");
    }
    console.log(`[headless-sync] first start bootstrap from ${seedConfig.sourcePath}`);
    await seedMirrorFromSource(seedConfig.sourcePath, mirrorRoot);
  }

  await saveState(mirrorRoot, state);
  console.log(`[headless-sync] deviceId=${state.deviceId} cursor=${state.cursor} localPush=${localPushEnabled ? "on" : "off"}`);

  try {
    await pullAndApplyUntilIdle(baseUrl, vaultId, token, mirrorRoot, state, () => stopping);
  } catch (error) {
    console.error(`[headless-sync] ${formatError(error)}`);
  }

  if (!loaded.existed) {
    await initializeLocalSnapshot(mirrorRoot, state);
    console.log("[headless-sync] initialized local snapshot baseline");
  }

  while (!stopping) {
    try {
      await pullAndApplyUntilIdle(baseUrl, vaultId, token, mirrorRoot, state, () => stopping);
      if (localPushEnabled) {
        await pushLocalChanges(baseUrl, vaultId, token, mirrorRoot, state);
      }
    } catch (error) {
      console.error(`[headless-sync] ${formatError(error)}`);
    }
    await sleep(pollIntervalMs);
  }

  await saveState(mirrorRoot, state);
  console.log("[headless-sync] stopped");
}

void main().catch((error) => {
  console.error(`[headless-sync] fatal: ${formatError(error)}`);
  process.exit(1);
});
