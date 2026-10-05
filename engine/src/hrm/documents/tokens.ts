import {
  hashPossessionToken,
  mintPossessionToken,
  verifyPossessionToken,
  type PossessionTokenClaims,
} from "../../platform/signing-tokens.ts";

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
 * Thin domain bindings over the shared possession-token core
 * (engine/src/platform/signing-tokens.ts): the domains, claims shape and
 * hash function are unchanged, so existing links keep verifying.
 */

// Domain separation: a document token can never verify as a survey token
// even though both HMAC with the deployment secret.
const DOCUMENT_DOMAIN = "hrm-document-sign:v1";
const SURVEY_DOMAIN = "hrm-survey-respond:v1";

export class HrmTokenError extends Error {
  readonly name = "HrmTokenError";
  constructor(message: string) {
    super(message);
  }
}

function requireSecret(): void {
  if (!process.env.SESSION_SECRET) {
    throw new HrmTokenError("SESSION_SECRET is required to mint HR signing tokens");
  }
}

export type HrmTokenClaims = PossessionTokenClaims;

/** SHA-256 hex digest stored in token_hash columns — the raw token never
 * touches storage, so a database read alone cannot sign. */
export function hashHrmToken(token: string): string {
  return hashPossessionToken(token);
}

/** Mint a signing link token for one hrm_document_signers row. */
export function mintDocumentSignerToken(orgId: string, signerId: string, expiresAt: Date): string {
  requireSecret();
  return mintPossessionToken(DOCUMENT_DOMAIN, orgId, signerId, expiresAt);
}

/** Verify a document signing token. Null = invalid or expired. */
export function verifyDocumentSignerToken(token: string): HrmTokenClaims | null {
  return verifyPossessionToken(DOCUMENT_DOMAIN, token);
}

/** Mint a response token for one hrm_survey_invitations row. */
export function mintSurveyInvitationToken(
  orgId: string,
  invitationId: string,
  expiresAt: Date,
): string {
  requireSecret();
  return mintPossessionToken(SURVEY_DOMAIN, orgId, invitationId, expiresAt);
}

/** Verify a survey response token. Null = invalid or expired. */
export function verifySurveyInvitationToken(token: string): HrmTokenClaims | null {
  return verifyPossessionToken(SURVEY_DOMAIN, token);
}
