import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./db.ts";

/**
 * Secret sealing (AES-256-GCM), engine-level so BOTH the web app (sealing on a
 * tenant's save) and the background worker (unsealing at run time) share it.
 * Keyed on the same OPENBOOKS_DATA_KEY and `enc:v1:` wire format the payments
 * engine uses for payee bank account numbers — one data key protects
 * everything at rest, and no plaintext secret ever lives outside the DB.
 *
 * (web/lib/secrets.ts is the server-only mirror of this for web-side use.)
 */

const ENC_PREFIX = "enc:v1:";

function dataKey(): Buffer {
  const raw = env.OPENBOOKS_DATA_KEY;
  if (!raw) {
    throw new Error(
      "OPENBOOKS_DATA_KEY is not set — required to encrypt stored connection secrets (32-byte key, hex or base64)",
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
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Seal/unseal a JSON object of credentials (the connection `secrets` blob). */
export function sealJson(obj: object): string {
  return sealSecret(JSON.stringify(obj));
}
export function unsealJson<T = Record<string, unknown>>(stored: string | null | undefined): T | null {
  const plain = unsealSecret(stored);
  if (plain === null) return null;
  try {
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}
