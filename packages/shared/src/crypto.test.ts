import { describe, expect, it } from "vitest";
import {
  decryptPayload,
  decryptVaultKeyForDevice,
  encryptPayload,
  encryptVaultKeyForDevice,
  generateDeviceKeyPair,
  generateVaultKey
} from "./crypto.js";

describe("crypto", () => {
  it("encrypts and decrypts payloads", () => {
    const key = generateVaultKey();
    const plain = Buffer.from("hello obsync");
    const cipher = encryptPayload(plain, key);
    const decrypted = decryptPayload(cipher, key);
    expect(decrypted.toString("utf8")).toBe("hello obsync");
  });

  it("wraps and unwraps vault keys", () => {
    const keyPair = generateDeviceKeyPair();
    const vaultKey = generateVaultKey();
    const wrapped = encryptVaultKeyForDevice(vaultKey, keyPair.publicKeyPem);
    const unwrapped = decryptVaultKeyForDevice(wrapped, keyPair.privateKeyPem);
    expect(unwrapped.equals(vaultKey)).toBe(true);
  });
});
