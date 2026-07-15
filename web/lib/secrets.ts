import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@openbooks/engine/src/db.ts";

/**
 * Server-only secret sealing (AES-256-GCM) — the beaconhs @beaconhs/crypto
 * pattern, keyed on the SAME OPENBOOKS_DATA_KEY and `enc:v1:` wire format the
 * payments engine already uses for payee bank account numbers
 * (engine/src/payments.ts), so one data key protects everything at rest.
 * Nothing secret ever lives in the environment beyond that key itself.
 */

const ENC_PREFIX = "enc:v1:";

function dataKey(): Buffer {
  const raw = env.OPENBOOKS_DATA_KEY;
  if (!raw) {
    throw new Error(
      "OPENBOOKS_DATA_KEY is not set in .env — required to encrypt stored secrets (32-byte key, hex or base64)",
    );
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("OPENBOOKS_DATA_KEY must decode to exactly 32 bytes (hex or base64)");
  }
  return buf;
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${ENC_PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

/** Null on any malformed/tampered input — callers treat that as "no secret". */
export function unsealSecret(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return null;
  const [ivB64, ctB64, tagB64] = stored.slice(ENC_PREFIX.length).split(":");
  if (!ivB64 || !ctB64 || !tagB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
