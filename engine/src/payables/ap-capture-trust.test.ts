import assert from "node:assert/strict";
import test from "node:test";
import {
  autoPostAmountDecision,
  autoPostEligibility,
  evaluateVendorTrust,
  type AutoPostPolicy,
  type VendorCaptureEvidence,
} from "./ap-capture-trust.ts";

function clean(id: string): VendorCaptureEvidence {
  return {
    captureItemId: id,
    documentId: `doc-${id}`,
    corrected: false,
    draftEdited: false,
    documentStatus: "posted",
    voided: false,
    automated: false,
  };
}

function automated(
  id: string,
  overrides: Partial<VendorCaptureEvidence> = {},
): VendorCaptureEvidence {
  return { ...clean(id), automated: true, ...overrides };
}

test("three clean, posted captures in a row earn trust and name exactly that evidence", () => {
  const trust = evaluateVendorTrust([clean("c4"), clean("c3"), clean("c2"), clean("c1")], 3);
  assert.equal(trust.trusted, true);
  assert.equal(trust.cleanStreak, 4);
  assert.deepEqual(trust.evidence, ["c4", "c3", "c2"]);
  assert.equal(trust.brokenBy, null);
});

test("a review correction breaks the streak at the newest edited capture", () => {
  const trust = evaluateVendorTrust(
    [clean("c4"), { ...clean("c3"), corrected: true }, clean("c2"), clean("c1")],
    3,
  );
  assert.equal(trust.trusted, false);
  assert.equal(trust.cleanStreak, 1);
  assert.deepEqual(trust.brokenBy, { captureItemId: "c3", reason: "edited" });
});

test("an edit to the draft bill after capture breaks the streak too", () => {
  const trust = evaluateVendorTrust(
    [{ ...clean("c3"), draftEdited: true }, clean("c2"), clean("c1")],
    2,
  );
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.brokenBy, { captureItemId: "c3", reason: "edited" });
});

test("a voided bill breaks the streak even when it was accepted unchanged", () => {
  const voided = evaluateVendorTrust(
    [clean("c3"), { ...clean("c2"), documentStatus: "voided" }, clean("c1")],
    2,
  );
  assert.equal(voided.trusted, false);
  assert.deepEqual(voided.brokenBy, { captureItemId: "c2", reason: "voided" });
  const pendingVoid = evaluateVendorTrust([{ ...clean("c2"), voided: true }, clean("c1")], 1);
  assert.equal(pendingVoid.trusted, false, "a requested void counts before it completes");
});

test("a bill still awaiting posting is not yet evidence", () => {
  const trust = evaluateVendorTrust(
    [{ ...clean("c3"), documentStatus: "draft" }, clean("c2"), clean("c1")],
    2,
  );
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.brokenBy, { captureItemId: "c3", reason: "not_posted" });
});

test("fewer captures than the threshold never earn trust", () => {
  assert.equal(evaluateVendorTrust([clean("c2"), clean("c1")], 3).trusted, false);
  assert.equal(evaluateVendorTrust([], 2).trusted, false);
  assert.throws(() => evaluateVendorTrust([], 0));
});

test("bills the policy posted are never evidence: they neither extend nor end a reviewed streak", () => {
  const trust = evaluateVendorTrust(
    [automated("a3"), automated("a2"), clean("c2"), automated("a1"), clean("c1")],
    2,
  );
  assert.equal(trust.trusted, true);
  assert.equal(trust.cleanStreak, 2, "only reviewed captures count toward the streak");
  assert.deepEqual(trust.evidence, ["c2", "c1"]);
  const pending = evaluateVendorTrust(
    [automated("a2", { documentStatus: "pending_approval" }), clean("c2"), clean("c1")],
    2,
  );
  assert.equal(
    pending.trusted,
    true,
    "an automated bill awaiting approval does not end the streak",
  );
  const onlyAutomated = evaluateVendorTrust([automated("a3"), automated("a2"), automated("a1")], 2);
  assert.equal(onlyAutomated.trusted, false, "automated postings alone never earn trust");
  assert.equal(onlyAutomated.cleanStreak, 0);
});

test("a void or edit of an automated bill still ends the streak, which reviewers must earn again", () => {
  const voided = evaluateVendorTrust(
    [clean("c3"), automated("a1", { voided: true }), clean("c2"), clean("c1")],
    2,
  );
  assert.equal(voided.trusted, false);
  assert.equal(voided.cleanStreak, 1);
  assert.deepEqual(voided.brokenBy, { captureItemId: "a1", reason: "voided" });
  const edited = evaluateVendorTrust(
    [automated("a2", { draftEdited: true }), clean("c2"), clean("c1")],
    2,
  );
  assert.deepEqual(edited.brokenBy, { captureItemId: "a2", reason: "edited" });
  const reEarned = evaluateVendorTrust(
    [clean("c5"), automated("a3"), clean("c4"), automated("a2", { voided: true }), clean("c2")],
    2,
  );
  assert.equal(reEarned.trusted, true, "reviewed captures after the break re-earn trust");
  assert.deepEqual(reEarned.evidence, ["c5", "c4"]);
});

const ON: AutoPostPolicy = {
  id: "p1",
  effectiveFrom: "2026-10-01",
  enabled: true,
  cleanStreak: 3,
  maxAmount: null,
  maxAmountCurrency: null,
};
type CaptureFacts = Parameters<typeof autoPostEligibility>[0]["capture"];
const READY: CaptureFacts = {
  status: "ready",
  documentKind: "vendor_bill",
  source: "upload",
  emailVerified: null,
  vendorId: "v1",
  issues: [],
  total: "1250.00",
  currency: "USD",
};

test("a ready bill from a trusted vendor is eligible under an enabled policy", () => {
  assert.deepEqual(autoPostEligibility({ policy: ON, trust: { trusted: true }, capture: READY }), {
    eligible: true,
  });
});

test("the policy is off by default and when its version disables it", () => {
  assert.deepEqual(
    autoPostEligibility({ policy: null, trust: { trusted: true }, capture: READY }),
    { eligible: false, reason: "policy_off" },
  );
  assert.deepEqual(
    autoPostEligibility({
      policy: { ...ON, enabled: false },
      trust: { trusted: true },
      capture: READY,
    }),
    { eligible: false, reason: "policy_off" },
  );
});

test("untrusted vendors, open issues, duplicates and credits stay in review", () => {
  const decide = (capture: Partial<CaptureFacts>, trusted = true) =>
    autoPostEligibility({ policy: ON, trust: { trusted }, capture: { ...READY, ...capture } });
  assert.deepEqual(decide({}, false), { eligible: false, reason: "vendor_not_trusted" });
  assert.deepEqual(
    decide({ status: "needs_review", issues: [{ code: "low_confidence", severity: "warning" }] }),
    { eligible: false, reason: "needs_review" },
  );
  assert.deepEqual(decide({ issues: [{ code: "po_price_variance", severity: "blocking" }] }), {
    eligible: false,
    reason: "needs_review",
  });
  assert.deepEqual(decide({ status: "duplicate" }), { eligible: false, reason: "duplicate" });
  assert.deepEqual(decide({ vendorId: null }), { eligible: false, reason: "vendor_unmatched" });
  assert.deepEqual(decide({ documentKind: "vendor_credit" }), {
    eligible: false,
    reason: "not_a_bill",
  });
});

test("the amount limit compares exact decimals in the policy currency only", () => {
  const limited = { ...ON, maxAmount: "1000.0000", maxAmountCurrency: "USD" };
  assert.deepEqual(
    autoPostEligibility({ policy: limited, trust: { trusted: true }, capture: READY }),
    { eligible: false, reason: "over_limit" },
  );
  assert.deepEqual(
    autoPostEligibility({
      policy: limited,
      trust: { trusted: true },
      capture: { ...READY, total: "1000.00" },
    }),
    { eligible: true },
    "a bill exactly at the limit qualifies",
  );
  assert.deepEqual(
    autoPostEligibility({
      policy: limited,
      trust: { trusted: true },
      capture: { ...READY, total: "1000.0001" },
    }),
    { eligible: false, reason: "over_limit" },
  );
  assert.deepEqual(
    autoPostEligibility({
      policy: limited,
      trust: { trusted: true },
      capture: { ...READY, total: "10.00", currency: "EUR" },
    }),
    { eligible: false, reason: "currency_differs" },
  );
  assert.deepEqual(
    autoPostEligibility({
      policy: ON,
      trust: { trusted: true },
      capture: { ...READY, total: "12,50" },
    }),
    { eligible: false, reason: "amount_unreadable" },
  );
});

test("emailed bills qualify only when the delivery signature verified against the address's secret", () => {
  const decide = (capture: Partial<CaptureFacts>) =>
    autoPostEligibility({
      policy: ON,
      trust: { trusted: true },
      capture: { ...READY, ...capture },
    });
  assert.deepEqual(decide({ source: "email", emailVerified: false }), {
    eligible: false,
    reason: "unsigned_email",
  });
  assert.deepEqual(decide({ source: "email", emailVerified: null }), {
    eligible: false,
    reason: "unsigned_email",
  });
  assert.deepEqual(decide({ source: "email", emailVerified: true }), { eligible: true });
  assert.deepEqual(
    decide({ source: "api", emailVerified: null }),
    { eligible: false, reason: "unsigned_email" },
    "an unknown channel fails closed",
  );
});

test("the posting-time limit check reads the draft's own total and currency", () => {
  const limited = { maxAmount: "1000.0000", maxAmountCurrency: "USD" };
  assert.deepEqual(autoPostAmountDecision(limited, { total: "1000.0000", currency: "USD" }), {
    eligible: true,
  });
  assert.deepEqual(autoPostAmountDecision(limited, { total: "1013.0000", currency: "USD" }), {
    eligible: false,
    reason: "over_limit",
  });
  assert.deepEqual(autoPostAmountDecision(limited, { total: "900.0000", currency: "CAD" }), {
    eligible: false,
    reason: "currency_differs",
  });
  assert.deepEqual(autoPostAmountDecision(limited, { total: null, currency: "USD" }), {
    eligible: false,
    reason: "amount_unreadable",
  });
  assert.deepEqual(
    autoPostAmountDecision(
      { maxAmount: null, maxAmountCurrency: null },
      { total: "99999.0000", currency: "EUR" },
    ),
    { eligible: true },
  );
});
