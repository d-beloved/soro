import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for the one place a phone number is stored: a pending reminder (see pipeline/nudge.ts).
// The key lives only in the gateway's environment (NUDGE_KEY), so the database alone can't reveal a number.

const VERSION = "v1";

/** Reads NUDGE_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). */
export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("NUDGE_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

/** `context` (the user id) is bound in, so a sealed number can't be moved to another user's row. */
export function seal(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** Throws if the key, the context or the sealed text doesn't match. */
export function unseal(sealed: string, key: Buffer, context: string): string {
  const [version, data] = sealed.split(":");
  if (version !== VERSION || !data) throw new Error("unknown sealed format");
  const raw = Buffer.from(data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
