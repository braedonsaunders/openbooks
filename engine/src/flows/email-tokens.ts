import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../db.ts";

/**
 * One-click signed email approvals — HMAC tokens that let a gate assignee
 * approve/reject straight from the notification email without a session
 * (exceeds source platform's reply-parsing approach: no inbound mail pipeline, no
 * spoofable From headers).
 *
 * Token format:  base64url(gateId|decision|assigneeUserId|expiryMs) . hmacHex
 * where the HMAC is sha256 over the raw `gateId|decision|assigneeUserId|expiry`
 * payload. The token binds ONE gate row + ONE decision + ONE assignee, so a
 * leaked approve link cannot reject, act on another gate, or impersonate a
 * different approver — and decideGate still authorizes the assignee normally.
 * Verification uses a constant-time compare.
 */

// The one-click approval route (/api/flows/email-action) is PUBLIC and
// sessionless — the HMAC token is the entire grant, so a weak/known key is an
// unauthenticated, cross-tenant approval-forgery hole. We therefore FAIL CLOSED:
// sign with the dedicated FLOWS_EMAIL_SECRET when set, else fall back to the
// deployment's SESSION_SECRET (always present, sealed per-tenant deploy), and
// throw if neither exists rather than degrade to a guessable constant.
function secret(): string {
  const key = env.FLOWS_EMAIL_SECRET || env.SESSION_SECRET;
  if (!key) {
    throw new Error(
      "FLOWS_EMAIL_SECRET or SESSION_SECRET must be set to sign one-click email approval links",
    );
  }
  return key;
}

// Domain-separation tag: mixed into every HMAC so a token signed here can never
// be replayed against another feature that also uses SESSION_SECRET.
const TOKEN_DOMAIN = "flows-email-action:v1";

// A bearer link sitting in an inbox is exposure; keep the window tight. The
// token is inert once the gate is decided, so 72h comfortably covers a normal
// approval turnaround without leaving week-long live links around.
export const EMAIL_TOKEN_TTL_MS = 72 * 3_600_000; // 72 hours

export interface EmailActionClaims {
  gateId: string;
  decision: "approved" | "rejected";
  assigneeUserId: string;
  /** Epoch ms after which the token is dead. */
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`${TOKEN_DOMAIN}|${payload}`).digest("hex");
}

/** Mint a one-click decision token for a gate row's assignee. */
export function createEmailActionToken(args: {
  gateId: string;
  decision: "approved" | "rejected";
  assigneeUserId: string;
  /** Override for tests; defaults to now + 7 days. */
  expiresAt?: number;
}): string {
  const expiresAt = args.expiresAt ?? Date.now() + EMAIL_TOKEN_TTL_MS;
  const payload = [args.gateId, args.decision, args.assigneeUserId, expiresAt].join("|");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

/** Verify a token: signature (constant-time) + expiry + shape. Null = invalid. */
export function verifyEmailActionToken(token: string): EmailActionClaims | null {
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
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const [gateId, decision, assigneeUserId, expStr] = payload.split("|");
  const expiresAt = Number(expStr);
  if (!gateId || !assigneeUserId || !Number.isFinite(expiresAt)) return null;
  if (decision !== "approved" && decision !== "rejected") return null;
  if (Date.now() > expiresAt) return null;
  return { gateId, decision, assigneeUserId, expiresAt };
}

/**
 * Absolute base URL for links in outbound email. Matches the render worker's
 * convention (engine/src/worker/render-client.ts: OPENBOOKS_APP_URL), with
 * APP_BASE_URL as a secondary alias and the dev web port as last resort.
 */
export function appBaseUrl(): string {
  return (env.OPENBOOKS_APP_URL || env.APP_BASE_URL || "http://localhost:4780").replace(/\/+$/, "");
}

/** The pair of one-click links for one gate row's assignee. */
export function emailActionUrls(gateId: string, assigneeUserId: string): {
  approveUrl: string;
  rejectUrl: string;
} {
  const base = appBaseUrl();
  const url = (decision: "approved" | "rejected") =>
    `${base}/api/flows/email-action?token=${encodeURIComponent(
      createEmailActionToken({ gateId, decision, assigneeUserId }),
    )}`;
  return { approveUrl: url("approved"), rejectUrl: url("rejected") };
}
