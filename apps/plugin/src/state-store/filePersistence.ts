import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SyncStatePersistence, SyncStateSnapshot } from "./stateStore.js";

export class JsonFileSyncStatePersistence implements SyncStatePersistence {
  constructor(private readonly persistPath: string) {}

  async load(): Promise<SyncStateSnapshot | null> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      return JSON.parse(raw) as SyncStateSnapshot;
    } catch (error) {
      const message = String(error);
      if (message.includes("ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  async save(snapshot: SyncStateSnapshot): Promise<void> {
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
