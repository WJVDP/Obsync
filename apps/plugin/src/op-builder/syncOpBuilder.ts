import { v4 as uuidv4 } from "uuid";
import type { SyncOp } from "@obsync/shared";
import type { VaultEvent } from "../event-capture/vaultEventCapture.js";

function inferOpType(event: VaultEvent): SyncOp["opType"] {
  if (event.type === "modify" && event.path.endsWith(".md")) {
    return "md_update";
  }
  if (event.type === "create") {
    return "file_create";
  }
  if (event.type === "rename") {
    return "file_rename";
  }
  if (event.type === "delete") {
    return "file_delete";
  }
  return "md_update";
}

export class SyncOpBuilder {
  private logicalClock = 0;

  constructor(private readonly deviceId: string) {}

  fromVaultEvent(event: VaultEvent, fileId?: string): SyncOp {
    this.logicalClock += 1;
    return {
      idempotencyKey: uuidv4(),
      deviceId: this.deviceId,
      fileId,
      path: event.path,
      opType: inferOpType(event),
      logicalClock: this.logicalClock,
      payload: {
        path: event.path,
        oldPath: event.oldPath,
        content: event.content,
        binaryContentBase64: event.binaryContentBase64,
        timestamp: event.timestamp
      },
      createdAt: new Date().toISOString()
    };
  }
}
