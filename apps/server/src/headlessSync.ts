import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { PullResponseSchema, type PullResponse } from "@obsync/shared";

interface HeadlessState {
  cursor: number;
  deviceId: string;
  docs: Record<string, string>;
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

async function loadState(mirrorRoot: string): Promise<HeadlessState> {
  const path = stateFilePath(mirrorRoot);
  if (!(await exists(path))) {
    return {
      cursor: 0,
      deviceId: randomUUID(),
      docs: {}
    };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<HeadlessState>;
  return {
    cursor: Number.isInteger(parsed.cursor) && parsed.cursor! >= 0 ? parsed.cursor! : 0,
    deviceId:
      typeof parsed.deviceId === "string" && parsed.deviceId.length > 0 ? parsed.deviceId : randomUUID(),
    docs: typeof parsed.docs === "object" && parsed.docs !== null ? (parsed.docs as Record<string, string>) : {}
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

function setMarkdownState(state: HeadlessState, path: string, content: string): void {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  state.docs[path] = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function mergeMarkdownUpdate(state: HeadlessState, path: string, updateBase64: string): string {
  const doc = new Y.Doc();
  const existing = state.docs[path];
  if (existing) {
    Y.applyUpdate(doc, Buffer.from(existing, "base64"));
  }

  Y.applyUpdate(doc, Buffer.from(updateBase64, "base64"));
  state.docs[path] = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  return doc.getText("content").toString();
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
          typeof op.payload.content === "string" ? op.payload.content : typeof op.payload.text === "string" ? op.payload.text : "";
        if (typeof op.payload.binaryContentBase64 === "string" && op.payload.binaryContentBase64.length > 0) {
          await writeBinaryFile(targetPath, Buffer.from(op.payload.binaryContentBase64, "base64"));
          delete state.docs[relativePath];
        } else {
          await writeTextFile(targetPath, content);
          if (relativePath.endsWith(".md")) {
            setMarkdownState(state, relativePath, content);
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
        break;
      }
      case "file_delete": {
        const relativePath = normalizeVaultRelativePath(op.payload.path);
        const targetPath = resolveWithinMirror(mirrorRoot, relativePath);
        await removeIfExists(targetPath);
        delete state.docs[relativePath];
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const baseUrl = readRequiredEnv("HEADLESS_BASE_URL");
  const vaultId = readRequiredEnv("HEADLESS_VAULT_ID");
  const token = readRequiredEnv("HEADLESS_API_TOKEN");
  const mirrorRoot = resolve(readRequiredEnv("HEADLESS_MIRROR_PATH"));
  const pollIntervalMs = readPollIntervalMs();

  await mkdir(mirrorRoot, { recursive: true });
  const state = await loadState(mirrorRoot);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[headless-sync] mirror=${mirrorRoot} vault=${vaultId} base=${baseUrl}`);
  console.log(`[headless-sync] deviceId=${state.deviceId} cursor=${state.cursor}`);

  while (!stopping) {
    try {
      const response = await pullOnce(baseUrl, vaultId, token, state.cursor, state.deviceId);
      if (response.ops.length > 0) {
        await applyRemoteOps(mirrorRoot, state, response);
        state.cursor = response.watermark;
        await saveState(mirrorRoot, state);
        console.log(`[headless-sync] applied=${response.ops.length} cursor=${state.cursor}`);
      }
    } catch (error) {
      console.error(`[headless-sync] ${String(error)}`);
    }
    await sleep(pollIntervalMs);
  }

  await saveState(mirrorRoot, state);
  console.log("[headless-sync] stopped");
}

void main().catch((error) => {
  console.error(`[headless-sync] fatal: ${String(error)}`);
  process.exit(1);
});
