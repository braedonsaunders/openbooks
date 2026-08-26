// Stable delivery identity + uncertain-outcome reconciliation vocabulary.
//
// Audit finding #52: a BullMQ jobId alone cannot prevent a duplicate send.
// Once a provider has accepted a transmission, a retry caused by a client
// timeout / crash / failed DB mark will hand it to the provider again unless
// (a) every attempt of one logical delivery derives the SAME stable identity,
// and (b) an unresolved outcome is recorded as such and reconciled — never
// blindly retried. This module owns both contracts; every transport composes
// them (identity goes onto the wire, outcomes come back off it).

import { createHash } from "node:crypto";

export const EMAIL_DELIVERY_ID_HEADER = "X-Openbooks-Delivery-Id";

const DELIVERY_KEY_PREFIX = "obem_";
const DELIVERY_KEY_INPUT = "openbooks.email-delivery.v1";
export const EMAIL_DELIVERY_KEY_PATTERN = /^obem_[0-9a-f]{40}$/;

/**
 * The result of one send attempt through any transport. Definite failures are
 * still thrown (callers keep their error UX); `uncertain` is RETURNED because
 * it is not a failure — it is an unknown that must be reconciled before the
 * same message is ever transmitted again.
 */
export type EmailSendOutcome =
  | { readonly kind: "sent"; readonly providerMessageId: string }
  | { readonly kind: "uncertain"; readonly reason: string };

/**
 * Deterministic identity for ONE logical delivery (one recipient, one queue
 * job or direct-send scope). Recomputing it after a crash must yield the same
 * value — that is what lets a provider recognize the replay (Resend idempotency
 * key, Message-ID) and what ties every attempt record together in email_log.
 *
 * Mailbox case is folded away: a retried attempt for `Dana@` vs `dana@` is the
 * same delivery, not fresh mail.
 */
export function deriveEmailDeliveryKey(input: { orgId: string; scope: string; to: string }): string {
  if (!input.orgId?.trim()) throw new Error("delivery key derivation requires the sending organization")
  if (!input.scope?.trim()) throw new Error("delivery key derivation requires its durable scope (job or log row)")
  if (!input.to?.trim()) throw new Error("delivery key derivation requires the recipient mailbox")
  return (
    DELIVERY_KEY_PREFIX +
    createHash("sha256")
      .update(DELIVERY_KEY_INPUT)
      .update("\0")
      .update(input.orgId.trim().toLowerCase())
      .update("\0")
      .update(input.scope.trim())
      .update("\0")
      .update(input.to.trim().toLowerCase())
      .digest("hex")
      .slice(0, 40)
  )
}

/** Boundary check for identities entering the transport layer. */
export function assertEmailDeliveryKey(deliveryKey: string): string {
  if (!EMAIL_DELIVERY_KEY_PATTERN.test(deliveryKey)) {
    throw new Error(`delivery key must match ${EMAIL_DELIVERY_KEY_PATTERN.source}`)
  }
  return deliveryKey
}

// --- Failure classification ---------------------------------------------------
//
// Only two honest verdicts exist once a request has left our hands:
//   notSent  — the provider demonstrably never processed the message, so the
//              normal retry path is safe;
//   uncertain— transmission may have completed on the provider side. Any
//              further attempt is a potential duplicate and must go through
//              reconciliation first.

export type NetworkFailureClass =
  | { outcome: "notSent"; reason: string }
  | { outcome: "uncertain"; reason: string };

/** Undici/fetch error causes that prove the request never reached the wire. */
const PRE_TRANSMISSION_CODES = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EACCES",
  "EPROTO",
]);

function causeCode(error: unknown): string | null {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (cause as { code?: unknown } | undefined)?.code
  return typeof code === "string" && code ? code : null
}

/** undici throws this exact message when a response redirects under `redirect: "error"`. */
const REDIRECT_REFUSAL = /unexpected redirect/i;

function causeChainMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = causeCode(current);
    if (code) messages.push(code);
    messages.push(current.message);
    current = current.cause as Error;
  }
  return messages;
}

/**
 * Classify a fetch-level failure inside an HTTP transport. Pre-transmission
 * errors (connect/DNS/TLS) are definitive non-sends; deadlines, aborts and
 * mid-flight socket loss fail closed as uncertain.
 */
export function classifyNetworkFailure(error: unknown): NetworkFailureClass {
  const name = error instanceof DOMException ? error.name : null
  const errName = name ?? (error instanceof Error ? error.name : String((error as { name?: unknown })?.name ?? ""))
  if (errName === "TimeoutError" || errName === "AbortError") {
    return { outcome: "uncertain", reason: `${errName}: request timed out before confirmation — acceptance state unresolved` }
  }
  const chain = causeChainMessages(error);
  if (chain.some((message) => REDIRECT_REFUSAL.test(message))) {
    // The provider answered by refusing to serve here; no redirect was
    // followed and the request never reached a third origin.
    return { outcome: "notSent", reason: "cross-origin redirect refused — provider did not accept at the requested origin" }
  }
  const code = causeCode(error)
  if (code && (PRE_TRANSMISSION_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("CERT_"))) {
    return { outcome: "notSent", reason: `network request failed (${code})` }
  }
  return { outcome: "uncertain", reason: "network request failed at an unresolvable phase — acceptance state unresolved" }
}

/** nodemailer error classes that occur strictly before message data flows. */
const SMTP_PRE_TRANSMISSION_CODES = new Set([
  "ECONNECTION",
  "EDNS",
  "ETLS",
  "EAUTH",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Classify a nodemailer failure against RFC 5321 semantics: only a final 250
 * acknowledgement after end-of-data obligates acceptance. A server reply is a
 * conversational rejection (definitely not queued). Deadlines/socket loss
 * without a reply may straddle the final ack, so they stay uncertain.
 */
export function classifySmtpFailure(error: unknown): NetworkFailureClass {
  const detail = error as { code?: string; response?: unknown }
  const response = typeof detail.response === "string" ? detail.response : ""
  if (response.trim()) {
    return { outcome: "notSent", reason: response.trim() }
  }
  const code = detail.code
  if (code && SMTP_PRE_TRANSMISSION_CODES.has(code)) {
    return { outcome: "notSent", reason: `connection failed before transmission (${code})` }
  }
  return { outcome: "uncertain", reason: `no SMTP confirmation received${code ? ` (${code})` : ""} — acceptance state unresolved` }
}

// --- Reconciliation ------------------------------------------------------------

export type AttemptOutcomeClass = "sent" | "notSent" | "uncertain";

export type AttemptRecord = {
  attempt: number;
  outcome: AttemptOutcomeClass;
  /** Provider message id when sent; failure/uncertainty detail otherwise. */
  detail?: string | null;
};

export type DeliveryReconciliation =
  | { action: "send" }
  | { action: "suppress"; reason: string }
  | { action: "complete"; providerMessageId: string };

/**
 * Decide what the next attempt of a logical delivery may do given its canonical
 * attempt lineage. This is the reconciliation gate:
 *
 * - One confirmed acceptance closes the job without touching the wire again,
 *   even if later bookkeeping looks confusing — the earliest confirmed id wins.
 * - Any unresolved attempt suppresses further transmissions with an explicit
 *   operator-facing reason; nothing here can mint a duplicate email.
 * - Clean lineage (no uncertainty, no acceptance yet) proceeds normally.
 */
export function reconcileDeliveryAttempts(lineage: readonly AttemptRecord[]): DeliveryReconciliation {
  const byAttempt = [...lineage].sort((a, b) => a.attempt - b.attempt);
  const firstSent = byAttempt.find((r) => r.outcome === "sent");
  if (firstSent?.detail) {
    return { action: "complete", providerMessageId: firstSent.detail };
  }

  const firstUncertain = byAttempt.find((r) => r.outcome === "uncertain");
  if (firstUncertain) {
    const summary = firstUncertain.detail?.trim() || "outcome unresolved";
    return {
      action: "suppress",
      reason:
        `attempt ${firstUncertain.attempt} ended unresolved (${summary}); whether the message carrying ` +
        `${EMAIL_DELIVERY_ID_HEADER} was accepted cannot be proven from here — it may have been accepted and ` +
        `delivered once — so delivery will not be resent until an operator reconciles it`,
    };
  }

  return { action: "send" };
}

/**
 * SMTP-level stable identity: a deterministic Message-ID (deduped downstream by
 * conforming MTAs/MUAs) plus our audit header so duplicates remain visible.
 */
export function buildSmtpIdentity(deliveryKey: string, from: string): { messageId: string; headers: Record<string, string> } {
  assertEmailDeliveryKey(deliveryKey)
  const senderDomain = (() => {
    const inner = from.includes("<") ? from.slice(from.lastIndexOf("<") + 1, from.lastIndexOf(">")) : from;
    const domain = inner.split("@")[1]?.trim().toLowerCase()
    if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/i.test(domain)) {
      throw new Error(`cannot derive a Message-ID domain from the sender address`)
    }
    return domain
  })()
  return {
    messageId: `<${deliveryKey}@${senderDomain}>`,
    headers: { [EMAIL_DELIVERY_ID_HEADER]: deliveryKey },
  }
}
