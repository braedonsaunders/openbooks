// Stable delivery identity + uncertain-outcome reconciliation contracts.
//
// The BullMQ jobId alone cannot stop a duplicated message: once a provider has
// accepted a transmission, a retry caused by a client timeout/crash/DB-mark
// failure sends the identical email again unless every attempt of one logical
// delivery carries the SAME stable identity and a reconciliation decision that
// refuses blind re-sends while an outcome is unresolved. These tests pin both
// properties independently of any provider.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_DELIVERY_ID_HEADER,
  buildSmtpIdentity,
  classifyNetworkFailure,
  classifySmtpFailure,
  deriveEmailDeliveryKey,
  reconcileDeliveryAttempts,
} from "./outcome";

const ORG = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";

test("delivery keys are stable per logical delivery and distinct otherwise", () => {
  const first = deriveEmailDeliveryKey({ orgId: ORG, scope: "job-a", to: "dana@example.com" });
  const replayed = deriveEmailDeliveryKey({ orgId: ORG, scope: "job-a", to: "Dana@example.com" });
  // Case differences in the mailbox cannot mint a second identity — the same
  // logical recipient delivered under the same job must always share one key,
  // or a retried attempt would look like brand-new mail.
  assert.equal(first, replayed);
  assert.match(first, /^obem_[0-9a-f]{40}$/);

  // Any durable input difference is a different delivery.
  assert.notEqual(first, deriveEmailDeliveryKey({ orgId: ORG, scope: "job-b", to: "dana@example.com" }));
  assert.notEqual(first, deriveEmailDeliveryKey({ orgId: ORG, scope: "job-a", to: "evan@example.com" }));
  assert.notEqual(
    first,
    deriveEmailDeliveryKey({ orgId: "018f6b2a-0000-7000-8000-000000000001", scope: "job-a", to: "dana@example.com" }),
  );
});

test("identity derivation fails closed on incomplete inputs", () => {
  assert.throws(() => deriveEmailDeliveryKey({ orgId: "", scope: "job-a", to: "dana@example.com" }));
  assert.throws(() => deriveEmailDeliveryKey({ orgId: ORG, scope: "", to: "dana@example.com" }));
  assert.throws(() => deriveEmailDeliveryKey({ orgId: ORG, scope: "job-a", to: "" }));
});

test("a timeout after acceptance reconciles to suppression, not a re-send", () => {
  // Attempt 1 hit its response deadline after the request went out; whether
  // the provider queued it is unknowable from here. The reconciliation for
  // any follow-up attempt must refuse to transmit again while that question
  // stands open — this is the exact duplicate-email scenario from the audit.
  const lineage = [
    { attempt: 1, outcome: "notSent" as const, detail: "connect refused before transmission" },
    { attempt: 2, outcome: "uncertain" as const, detail: "Resend: request timed out after 30 seconds" },
  ];
  const decision = reconcileDeliveryAttempts(lineage);
  assert.equal(decision.action, "suppress");
  if (decision.action === "suppress") {
    assert.match(decision.reason, /attempt 2/u);
    assert.ok(decision.reason.includes(EMAIL_DELIVERY_ID_HEADER));
    assert.match(decision.reason, /may\s+have\s+been\s+(accepted|delivered)/iu);
    assert.match(decision.reason, /will\s+not\s+be\s+resent/iu);
  }

  // No uncertain sibling — even several definite failures — still allows the
  // next attempt: nothing ever left the building unconfirmed.
  const safeLineage = [{ attempt: 1, outcome: "notSent" as const, detail: "connection refused" }];
  assert.deepEqual(reconcileDeliveryAttempts(safeLineage), { action: "send" });
  assert.deepEqual(reconcileDeliveryAttempts([]), { action: "send" });
});

test("an attempt with confirmed acceptance completes the delivery idempotently", () => {
  const decision = reconcileDeliveryAttempts([
    { attempt: 1, outcome: "sent" as const, detail: "email_123" },
  ]);
  assert.deepEqual(decision, { action: "complete", providerMessageId: "email_123" });

  // Acceptance wins over later noise — including a subsequent uncertain
  // detail — because the earlier evidence is authoritative: one confirmed
  // provider id means the job closes without touching the wire again.
  const noisy = reconcileDeliveryAttempts([
    { attempt: 1, outcome: "sent" as const, detail: "postmark_9" },
    { attempt: 2, outcome: "uncertain" as const, detail: "marker fell out of meta" },
  ]);
  assert.deepEqual(noisy, { action: "complete", providerMessageId: "postmark_9" });
});

test("network failures are classified by what could have been transmitted", () => {
  // Request never crossed to the provider — a fresh attempt is safe.
  const refused = classifyNetworkFailure(new Error("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
  }));
  assert.equal(refused.outcome, "notSent");

  const dns = classifyNetworkFailure(new Error("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example"), { code: "ENOTFOUND" }),
  }));
  assert.equal(dns.outcome, "notSent");

  const tls = classifyNetworkFailure(new Error("fetch failed", {
    cause: Object.assign(new Error("certificate self-signed"), { code: "CERT_HAS_EXPIRED" }),
  }));
  assert.equal(tls.outcome, "notSent");

  // Ambiguity fails closed: a deadline mid-flight may still have handed the
  // message to the provider, so the caller records uncertainty rather than
  // blindly transmitting again.
  const deadline = classifyNetworkFailure(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(deadline.outcome, "uncertain");
  assert.match(deadline.reason, /timed out|outcome/iu);

  const aborted = classifyNetworkFailure(new DOMException("This operation was aborted", "AbortError"));
  assert.equal(aborted.outcome, "uncertain");

  // A socket cut at an unknown phase could be either side of acceptance;
  // only genuine pre-transmission codes earn a definitive verdict.
  const reset = classifyNetworkFailure(new Error("other side closed", {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  }));
  assert.equal(reset.outcome, "uncertain");
});

test("smtp failures are classified by protocol phase evidence", () => {
  // A conversational negative reply (pre-DATA reject here) is definitive.
  const rejected = classifySmtpFailure(Object.assign(new Error("bad sequence of commands"), {
    code: "EENVELOPE",
    response: "550 5.1.1 <x@nowhere> recipient rejected",
    responseCode: 550,
  }));
  assert.equal(rejected.outcome, "notSent");
  assert.match(rejected.reason, /550/u);

  // Connection/auth/TLS phases precede any MAIL FROM — safe to try again.
  assert.equal(classifySmtpFailure(Object.assign(new Error("timeout"), { code: "ECONNREFUSED" })).outcome, "notSent");
  assert.equal(classifySmtpFailure(Object.assign(new Error("auth failed"), { code: "EAUTH" })).outcome, "notSent");
  assert.equal(classifySmtpFailure(Object.assign(new Error("tls"), { code: "ETLS" })).outcome, "notSent");

  // A deadline with no reply can straddle the final DATA acknowledgement:
  // if it arrived after our last byte, some relays have already spooled the
  // message, so the honest class is uncertain.
  const late = classifySmtpFailure(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }));
  assert.equal(late.outcome, "uncertain");

  const dropped = classifySmtpFailure(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  assert.equal(dropped.outcome, "uncertain");
});

test("smtp identity rides a stable Message-ID plus the delivery header", () => {
  const identity = buildSmtpIdentity("obem_0123456789abcdef0123456789abcdef01234567", "Ops <ops@example.com>");
  assert.equal(identity.messageId, "<obem_0123456789abcdef0123456789abcdef01234567@example.com>");
  assert.equal(identity.headers[EMAIL_DELIVERY_ID_HEADER], "obem_0123456789abcdef0123456789abcdef01234567");

  const bare = buildSmtpIdentity("obem_ffffffffffffffffffffffffffffffffffffffff", "ops@example.com");
  assert.equal(bare.messageId, "<obem_ffffffffffffffffffffffffffffffffffffffff@example.com>");

  assert.throws(() => buildSmtpIdentity("no-prefix-value", "ops@example.com"));
  assert.throws(() => buildSmtpIdentity("obem_" + "a".repeat(40), "ops@@broken"));
});
