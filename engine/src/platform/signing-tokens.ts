import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Possession tokens for out-of-band signer links (document signing, survey
 * responses, quote e-signatures).
 *
 * Whoever holds the link can act, exactly like a paper sheet handed across
 * the counter. The token binds ONE row in ONE org; the persisted row adds
 * expiry, revocation (voided / re-issued), and single consumption.
 * Cryptographic validity alone never authorizes — every use re-validates
 * the row.
 *
 * Pure: no imports from any engine module, so unit tests exercise the
 * exact code the routes use (never double a pure function — this IS the
 * function). Each family mints under its own domain string, so a token for
 * one subject can never verify as another even though all HMAC with the
 * deployment secret.
 */

export class PossessionTokenError extends Error {
  readonly name = "PossessionTokenError";
}

function secret(): string {
  // Live read: engine db.ts snapshots the environment at module evaluation,
  // so a snapshot read misses a secret assigned after that import.
  const key = process.env.SESSION_SECRET;
  if (!key) {
    throw new PossessionTokenError("SESSION_SECRET is required to mint possession tokens");
  }
  return key;
}

function sign(domain: string, payload: string): string {
  return createHmac("sha256", secret()).update(`${domain}|${payload}`).digest("hex");
}

export interface PossessionTokenClaims {
  orgId: string;
  rowId: string;
  expiresAt: Date;
}

/** Mint a possession-token link for one subject row. */
export function mintPossessionToken(
  domain: string,
  orgId: string,
  rowId: string,
  expiresAt: Date,
): string {
  const nonce = randomBytes(16).toString("hex");
  const payload = `${orgId}.${rowId}.${expiresAt.getTime()}.${nonce}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(domain, payload)}`;
}

/** Verify a possession token. Null = invalid or expired. */
export function verifyPossessionToken(domain: string, token: string): PossessionTokenClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(domain, payload), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [orgId, rowId, expStr] = payload.split(".");
  if (!orgId || !rowId || !expStr) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { orgId, rowId, expiresAt: new Date(exp) };
}

/** SHA-256 hex digest stored in token_hash columns — the raw token never
 * touches storage, so a database read alone cannot sign. */
export function hashPossessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
