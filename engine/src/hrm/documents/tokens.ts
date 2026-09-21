import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HR-19 possession tokens for document signers and survey respondents.
 *
 * Same trust model as the field-ticket customer-sign links
 * (web/lib/field-ticket-token.ts): whoever holds the link can act, exactly
 * like the paper sheet handed across the counter. The token binds ONE row
 * (signer or invitation) in ONE org; the persisted row adds expiry,
 * revocation (document voided / survey closed), and single consumption.
 * Cryptographic validity alone never authorizes — every use re-validates
 * the row.
 *
 * Pure: no imports from any engine module, so unit tests exercise the
 * exact code the routes use (never double a pure function — this IS the
 * function).
 */

// Domain separation: a document token can never verify as a survey token
// even though both HMAC with the deployment secret.
const DOCUMENT_DOMAIN = "hrm-document-sign:v1";
const SURVEY_DOMAIN = "hrm-survey-respond:v1";

function secret(): string {
  // Live read: engine db.ts snapshots the environment at module evaluation,
  // so a snapshot read misses a secret assigned after that import.
  const key = process.env.SESSION_SECRET;
  if (!key) {
    throw new HrmTokenError("SESSION_SECRET is required to mint HR signing tokens");
  }
  return key;
}

export class HrmTokenError extends Error {
  readonly name = "HrmTokenError";
}

function sign(domain: string, payload: string): string {
  return createHmac("sha256", secret()).update(`${domain}|${payload}`).digest("hex");
}

function mint(domain: string, orgId: string, rowId: string, expiresAt: Date): string {
  const nonce = randomBytes(16).toString("hex");
  const payload = `${orgId}.${rowId}.${expiresAt.getTime()}.${nonce}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(domain, payload)}`;
}

export interface HrmTokenClaims {
  orgId: string;
  rowId: string;
  expiresAt: Date;
}

function verify(domain: string, token: string): HrmTokenClaims | null {
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
export function hashHrmToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a signing link token for one hrm_document_signers row. */
export function mintDocumentSignerToken(orgId: string, signerId: string, expiresAt: Date): string {
  return mint(DOCUMENT_DOMAIN, orgId, signerId, expiresAt);
}

/** Verify a document signing token. Null = invalid or expired. */
export function verifyDocumentSignerToken(token: string): HrmTokenClaims | null {
  return verify(DOCUMENT_DOMAIN, token);
}

/** Mint a response token for one hrm_survey_invitations row. */
export function mintSurveyInvitationToken(
  orgId: string,
  invitationId: string,
  expiresAt: Date,
): string {
  return mint(SURVEY_DOMAIN, orgId, invitationId, expiresAt);
}

/** Verify a survey response token. Null = invalid or expired. */
export function verifySurveyInvitationToken(token: string): HrmTokenClaims | null {
  return verify(SURVEY_DOMAIN, token);
}
