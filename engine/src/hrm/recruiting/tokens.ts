import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Recruiting depth sessionless tokens (HR-18, 0229).
 *
 * Candidate self-booking, offer e-sign, and the public job feed ride PUBLIC
 * token routes with no session — the HMAC token is the entire grant. This
 * reuses the one-click email-approval primitive's construction
 * (engine/src/flows/email-tokens.ts): base64url(payload).hmacHex over
 * sha256 with a deployment secret, constant-time verify, tight expiry —
 * under its own domain-separation tag so a token minted here can never
 * replay against flows email actions or any other signer sharing the
 * SESSION_SECRET fallback.
 *
 * Token format: base64url(purpose|rowId|expiryMs).hmacHex. The token binds
 * ONE purpose + ONE row, so a leaked booking link cannot sign an offer,
 * act on another interview, or read the feed — and every consumer still
 * authorizes the row normally (expiry, status, signature state).
 *
 * Pure: no database, no clock beyond Date.now (overridable per call), so
 * unit tests mint and verify directly.
 */

const TOKEN_DOMAIN = "hrm-recruiting-token:v1";

export const BOOKING_TOKEN_TTL_MS = 14 * 24 * 3_600_000; // 14 days
export const OFFER_TOKEN_TTL_MS = 30 * 24 * 3_600_000; // 30 days
export const FEED_TOKEN_TTL_MS = 365 * 24 * 3_600_000; // 1 year

export type RecruitingTokenPurpose = "book" | "offer" | "feed";

export interface RecruitingTokenClaims {
  purpose: RecruitingTokenPurpose;
  rowId: string;
  /** Epoch ms after which the token is dead. */
  expiresAt: number;
}

function secret(): string {
  // Same key selection as the field-ticket signing surface this reuses:
  // the dedicated secret when set, else the deployment session secret.
  // Fail closed — a guessable constant would be a cross-tenant forgery hole.
  const key = process.env.FLOWS_EMAIL_SECRET || process.env.SESSION_SECRET;
  if (!key) {
    throw new Error(
      "FLOWS_EMAIL_SECRET or SESSION_SECRET must be set to sign recruiting links",
    );
  }
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`${TOKEN_DOMAIN}|${payload}`).digest("hex");
}

/** Mint a sessionless token binding one purpose + one row. */
export function createRecruitingToken(args: {
  purpose: RecruitingTokenPurpose;
  rowId: string;
  /** Override for tests; defaults to now + the purpose TTL. */
  expiresAt?: number;
}): string {
  if (!args.rowId) throw new Error("a recruiting token needs a row id — name the interview, offer, or org it opens");
  const ttl =
    args.purpose === "book"
      ? BOOKING_TOKEN_TTL_MS
      : args.purpose === "offer"
        ? OFFER_TOKEN_TTL_MS
        : FEED_TOKEN_TTL_MS;
  const expiresAt = args.expiresAt ?? Date.now() + ttl;
  const payload = [args.purpose, args.rowId, expiresAt].join("|");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

/**
 * Verify a token for the expected purpose. Null = invalid, forged,
 * expired, or minted for another purpose. Never throws on attacker input
 * (only on a missing server secret, which is an operator misconfiguration).
 */
export function verifyRecruitingToken(
  token: string,
  purpose: RecruitingTokenPurpose,
): RecruitingTokenClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload), "utf8");
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  const [tokenPurpose, rowId, expiryRaw] = payload.split("|");
  if (tokenPurpose !== purpose || !rowId) return null;
  const expiresAt = Number(expiryRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { purpose, rowId, expiresAt };
}

/** The stored booking-link identity: SHA-256 hex of the raw token. The raw token is shown once and emailed, never stored. */
export function hashRecruitingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Random raw token material for booking links (signed envelope aside). */
export function randomTokenMaterial(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
