import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type KeyObject
} from "node:crypto";

export interface DeviceKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface CipherText {
  ivBase64: string;
  cipherTextBase64: string;
  authTagBase64: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" }
  });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export function generateVaultKey(): Buffer {
  return randomBytes(32);
}

export function encryptVaultKeyForDevice(vaultKey: Buffer, devicePublicKeyPem: string): string {
  const encrypted = publicEncrypt(
    {
      key: devicePublicKeyPem,
      oaepHash: "sha256"
    },
    vaultKey
  );
  return encrypted.toString("base64");
}

export function decryptVaultKeyForDevice(encryptedVaultKeyBase64: string, devicePrivateKeyPem: string): Buffer {
  return privateDecrypt(
    {
      key: devicePrivateKeyPem,
      oaepHash: "sha256"
    },
    Buffer.from(encryptedVaultKeyBase64, "base64")
  );
}

export function encryptPayload(plain: Buffer, key: Buffer): CipherText {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ivBase64: iv.toString("base64"),
    cipherTextBase64: cipherText.toString("base64"),
    authTagBase64: authTag.toString("base64")
  };
}

export function decryptPayload(cipherText: CipherText, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipherText.ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(cipherText.authTagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText.cipherTextBase64, "base64")),
    decipher.final()
  ]);
}

export function sha256Base64(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("base64");
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}
