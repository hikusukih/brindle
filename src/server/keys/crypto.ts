import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with a fresh 96-bit nonce per value, as docs/design/key-manager.md settles.
export type Sealed = { nonce: string; ciphertext: string };

/** The associated data binds a ciphertext to its row: moving it to another secret, or editing the scope, fails to decrypt. */
export const aadFor = (id: string, name: string, scopeHash: string) =>
  Buffer.from(`${id}\0${name}\0${scopeHash}`, "utf8");

export function seal(key: Buffer, plaintext: string, aad: Buffer): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce: nonce.toString("base64"), ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64") };
}

export function open(key: Buffer, sealed: Sealed, aad: Buffer): string {
  const raw = Buffer.from(sealed.ciphertext, "base64");
  if (raw.length < 16) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
}
