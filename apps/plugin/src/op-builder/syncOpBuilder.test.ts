import { describe, expect, it } from "vitest";
import { SyncOpBuilder } from "./syncOpBuilder.js";

describe("SyncOpBuilder", () => {
  it("creates monotonic logical clocks", () => {
    const builder = new SyncOpBuilder("5d5472ff-97ae-4c76-8e14-645f4c47b452");
    const a = builder.fromVaultEvent({ type: "modify", path: "test.md", timestamp: new Date().toISOString() });
    const b = builder.fromVaultEvent({ type: "modify", path: "test.md", timestamp: new Date().toISOString() });

    expect(a.logicalClock).toBe(1);
    expect(b.logicalClock).toBe(2);
    expect(a.opType).toBe("md_update");
  });
});
