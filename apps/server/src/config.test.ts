import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("rejects weak JWT secret in production", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        PORT: "8080",
        JWT_SECRET: "change-me",
        DATABASE_URL: "postgres://obsync:obsync@localhost:5432/obsync"
      })
    ).toThrow("JWT_SECRET is too weak for production");
  });

  it("allows development defaults", () => {
    const config = readConfig({
      NODE_ENV: "development",
      PORT: "8080"
    });

    expect(config.port).toBe(8080);
    expect(config.jwtSecret).toBe("change-me");
  });
});
