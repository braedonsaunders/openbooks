/**
 * HR-20 kiosk identity primitives.
 *
 * A PIN is a kiosk identity, never a password: scrypt salt:hash in the
 * same shape as the seed-user KDF, verified in constant time. Device
 * tokens are high-entropy bearer secrets — only the SHA-256 hash is
 * stored, the raw token is shown once at issue.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { FieldTimeError } from "./errors.ts";

export function hashPin(pin: string): string {
  if (!/^\d{4,10}$/.test(pin)) {
    throw new FieldTimeError(
      "invalid_pin",
      "A clock PIN is 4 to 10 digits — choose a numeric PIN and try again",
    );
  }
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pin, salt, 64).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts as [string, string];
  let candidate: Buffer;
  try {
    candidate = scryptSync(pin, Buffer.from(saltHex, "hex"), 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Issue a raw device token; store only its hash. */
export function issueDeviceToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
