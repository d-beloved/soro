import { createHash } from "node:crypto";

/** Salted SHA-256 of an E.164-ish phone number. The raw number is never persisted. */
export function hashPhone(phone: string, salt: string): string {
  const normalized = phone.replace(/[^\d]/g, "");
  return createHash("sha256").update(`${salt}:${normalized}`).digest("hex");
}
