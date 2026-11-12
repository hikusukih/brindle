import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with a fresh 96-bit nonce per value, as docs/design/key-manager.md settles.
export type Sealed = { nonce: string; ciphertext: string };

/**
 * The associated data binds a ciphertext to its row: moving it to another secret, or editing its name, kind, header,
 * expiry or scope, fails to decrypt. Callers pass a hash computed from the scope as stored, never a stored hash.
 */
export const aadFor = (f: {
  id: string;
  name: string;
  kind: string;
  headerName: string | null;
  expiresAt: string | null;
  scopeHash: string;
}) => Buffer.from(JSON.stringify([f.id, f.name, f.kind, f.headerName, f.expiresAt, f.scopeHash]), "utf8");

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
