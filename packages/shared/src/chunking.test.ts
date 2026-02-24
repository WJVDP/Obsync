import { describe, expect, it } from "vitest";
import { chunkBuffer, joinChunks } from "./chunking.js";

describe("chunking", () => {
  it("splits and rejoins a buffer", () => {
    const original = Buffer.from("abc".repeat(10000), "utf8");
    const chunks = chunkBuffer(original, 1024);
    const rejoined = joinChunks(chunks);
    expect(rejoined.equals(original)).toBe(true);
  });
});
