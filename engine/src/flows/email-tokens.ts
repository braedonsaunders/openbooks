import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../db.ts";

/**
 * One-click signed email approvals — HMAC tokens that let a gate assignee
 * approve/reject straight from the notification email without a session
 * (exceeds NetSuite's reply-parsing approach: no inbound mail pipeline, no
 * spoofable From headers).
 *
 * Token format:  base64url(gateId|decision|assigneeUserId|expiryMs) . hmacHex
 * where the HMAC is sha256 over the raw `gateId|decision|assigneeUserId|expiry`
 * payload. The token binds ONE gate row + ONE decision + ONE assignee, so a
 * leaked approve link cannot reject, act on another gate, or impersonate a
 * different approver — and decideGate still authorizes the assignee normally.
 * Verification uses a constant-time compare.
 */

// LOUD WARNING: the 'dev' fallback below exists ONLY so local development
// works without configuration. Every real deployment MUST set
// FLOWS_EMAIL_SECRET (a long random string) in the environment — with the
// fallback, anyone who knows a gate id could forge approval links.
function secret(): string {
  return env.FLOWS_EMAIL_SECRET || "dev";
}

export const EMAIL_TOKEN_TTL_MS = 7 * 24 * 3_600_000; // 7 days

export interface EmailActionClaims {
  gateId: string;
  decision: "approved" | "rejected";
  assigneeUserId: string;
  /** Epoch ms after which the token is dead. */
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
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
