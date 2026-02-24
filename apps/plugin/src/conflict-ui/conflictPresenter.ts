import type { ConflictRecord } from "@obsync/shared";

export interface ConflictPresenter {
  show(record: ConflictRecord): void;
}

export class ConsoleConflictPresenter implements ConflictPresenter {
  show(record: ConflictRecord): void {
    // Replace this with Obsidian Notice/Modal in a live plugin.
    console.warn("[Obsync conflict]", record.path, record.reason);
  }
}
