import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("hashes and verifies passwords", () => {
    const hash = hashPassword("secret");
    expect(verifyPassword("secret", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });
});
