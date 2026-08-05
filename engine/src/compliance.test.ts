import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  daysBetween,
  evaluateBillRelease,
  evaluateLienWaiverCoverage,
  evaluateRequirement,
  evaluateVendorCompliance,
  type EvidenceRecord,
  type LienWaiverEvidence,
  type RequirementPolicy,
  type WaiverRecord,
} from "./compliance.ts";

const ASOF = "2026-07-01";

function policy(over: Partial<RequirementPolicy> = {}): RequirementPolicy {
  return {
    id: "req-gl",
    code: "GL",
    name: "General Liability",
    category: "insurance",
    classId: "class-trade",
    requiresExpiry: true,
    minCoverageAmount: null,
    minAggregateAmount: null,
    coverageCurrency: null,
    requiresAdditionalInsured: false,
    requiresWaiverOfSubrogation: false,
    requiresPrimaryNoncontributory: false,
    enforcement: "block_payment",
    graceDays: 0,
    expiryWarningDays: 30,
    requiresVerification: true,
    ...over,
  };
}

function evidence(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "rec-1",
    requirementId: "req-gl",
    projectId: null,
    status: "active",
    effectiveFrom: "2026-01-01",
    expiresOn: "2027-01-01",
    coverageAmount: null,
    aggregateAmount: null,
    coverageCurrency: null,
    additionalInsured: false,
    waiverOfSubrogation: false,
    primaryNoncontributory: false,
    verifiedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function waiver(over: Partial<WaiverRecord> = {}): WaiverRecord {
  return {
    id: "wv-1",
    requirementId: "req-gl",
    projectId: null,
    effectiveFrom: "2026-06-01",
    expiresOn: "2026-08-01",
    revokedAt: null,
    ...over,
  };
}

const evaluate = (p: RequirementPolicy, records: EvidenceRecord[], waivers: WaiverRecord[] = [], projectId: string | null = null) =>
  evaluateRequirement({ policy: p, records, waivers, asOf: ASOF, projectId });

// --- date helpers ----------------------------------------------------------

test("daysBetween and addDays are calendar-exact across a leap day", () => {
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2);
  assert.equal(daysBetween("2027-02-28", "2027-03-01"), 1);
  assert.equal(daysBetween("2026-07-01", "2026-06-29"), -2);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

// --- basic states ----------------------------------------------------------

test("current verified evidence is compliant", () => {
  const f = evaluate(policy(), [evidence()]);
  assert.equal(f.state, "compliant");
  assert.equal(f.blocksPayment, false);
  assert.deepEqual(f.reasons, []);
  assert.equal(f.daysToExpiry, daysBetween(ASOF, "2027-01-01"));
});

test("no evidence on file blocks when the policy blocks payment", () => {
  const f = evaluate(policy(), []);
  assert.equal(f.state, "missing");
  assert.deepEqual(f.reasons, ["no_evidence"]);
  assert.equal(f.blocksPayment, true);
  assert.equal(f.blocksBill, false);
});

test("evidence inside the warning window is expiring, not failing", () => {
  const f = evaluate(policy({ expiryWarningDays: 30 }), [evidence({ expiresOn: "2026-07-20" })]);
  assert.equal(f.state, "expiring");
  assert.equal(f.blocksPayment, false);
});

test("expired evidence blocks once the grace window closes", () => {
  const lapsed = evidence({ expiresOn: "2026-06-20" });
  assert.equal(evaluate(policy({ graceDays: 0 }), [lapsed]).state, "expired");
  // 11 days lapsed, 15 days of grace: still covered, and reported as expiring
  // because it is past its expiry date rather than comfortably in force.
  const graced = evaluate(policy({ graceDays: 15 }), [lapsed]);
  assert.equal(graced.state, "expiring");
  assert.equal(graced.blocksPayment, false);
  assert.equal(evaluate(policy({ graceDays: 10 }), [lapsed]).blocksPayment, true);
});

test("unverified evidence does not count while the policy requires verification", () => {
  const unverified = evidence({ verifiedAt: null });
  const f = evaluate(policy({ requiresVerification: true }), [unverified]);
  assert.equal(f.state, "awaiting_verification");
  assert.equal(f.blocksPayment, true);
  assert.equal(evaluate(policy({ requiresVerification: false }), [unverified]).state, "compliant");
});

test("pending_review evidence never counts, even when verification is optional", () => {
  const f = evaluate(policy({ requiresVerification: false }), [evidence({ status: "pending_review", verifiedAt: null })]);
  assert.equal(f.state, "awaiting_verification");
});

test("rejected evidence is reported as rejected, not missing", () => {
  const f = evaluate(policy(), [evidence({ status: "rejected" })]);
  assert.equal(f.state, "rejected");
  assert.deepEqual(f.reasons, ["rejected"]);
});

test("superseded evidence answers for nothing", () => {
  const f = evaluate(policy(), [evidence({ status: "superseded" })]);
  assert.equal(f.state, "missing");
  assert.equal(f.recordId, null);
});

test("evidence dated in the future is not yet in force", () => {
  const f = evaluate(policy(), [evidence({ effectiveFrom: "2026-09-01", expiresOn: "2027-09-01" })]);
  assert.equal(f.state, "insufficient");
  assert.ok(f.reasons.includes("not_yet_effective"));
});

test("a policy that requires an expiry rejects evidence without one", () => {
  const f = evaluate(policy({ requiresExpiry: true }), [evidence({ expiresOn: null })]);
  assert.equal(f.state, "insufficient");
  assert.ok(f.reasons.includes("expired"));
  // A W-9 has no expiry, and its policy says so.
  assert.equal(evaluate(policy({ requiresExpiry: false, category: "tax_form" }), [evidence({ expiresOn: null })]).state, "compliant");
});

// --- limits and endorsements ----------------------------------------------

test("coverage below the configured minimum is insufficient", () => {
  const p = policy({ minCoverageAmount: "2000000", coverageCurrency: "USD" });
  const short = evaluate(p, [evidence({ coverageAmount: "1000000", coverageCurrency: "USD" })]);
  assert.equal(short.state, "insufficient");
  assert.deepEqual(short.reasons, ["coverage_below_minimum"]);
  assert.equal(short.blocksPayment, true);
  // Exactly at the limit satisfies it.
  assert.equal(evaluate(p, [evidence({ coverageAmount: "2000000", coverageCurrency: "USD" })]).state, "compliant");
});

test("aggregate minimum is checked independently of per-occurrence", () => {
  const p = policy({ minCoverageAmount: "1000000", minAggregateAmount: "2000000", coverageCurrency: "USD" });
  const f = evaluate(p, [evidence({ coverageAmount: "1000000", aggregateAmount: "1000000", coverageCurrency: "USD" })]);
  assert.deepEqual(f.reasons, ["aggregate_below_minimum"]);
});

test("a limit with no amount on the certificate fails closed", () => {
  const p = policy({ minCoverageAmount: "1000000", coverageCurrency: "USD" });
  const f = evaluate(p, [evidence({ coverageAmount: null, coverageCurrency: "USD" })]);
  assert.equal(f.state, "insufficient");
  assert.deepEqual(f.reasons, ["coverage_amount_missing"]);
});

test("a limit stated in another currency is refused, never silently converted", () => {
  const p = policy({ minCoverageAmount: "2000000", coverageCurrency: "USD" });
  const f = evaluate(p, [evidence({ coverageAmount: "3000000", coverageCurrency: "CAD" })]);
  assert.equal(f.state, "insufficient");
  assert.ok(f.reasons.includes("coverage_currency_mismatch"));
  assert.equal(f.blocksPayment, true);
});

test("missing endorsements are reported individually", () => {
  const p = policy({
    requiresAdditionalInsured: true,
    requiresWaiverOfSubrogation: true,
    requiresPrimaryNoncontributory: true,
  });
  const f = evaluate(p, [evidence({ additionalInsured: true })]);
  assert.deepEqual(f.reasons, ["missing_waiver_of_subrogation", "missing_primary_noncontributory"]);
  assert.equal(f.state, "insufficient");
});

// --- picking among several certificates -----------------------------------

test("an early renewal covers a lapsed certificate", () => {
  const f = evaluate(policy(), [
    evidence({ id: "old", expiresOn: "2026-06-01" }),
    evidence({ id: "new", effectiveFrom: "2026-06-01", expiresOn: "2027-06-01" }),
  ]);
  assert.equal(f.state, "compliant");
  assert.equal(f.recordId, "new");
});

test("among equally compliant certificates the furthest expiry is reported", () => {
  const f = evaluate(policy(), [
    evidence({ id: "short", expiresOn: "2026-11-01" }),
    evidence({ id: "long", expiresOn: "2027-11-01" }),
  ]);
  assert.equal(f.recordId, "long");
  assert.equal(f.expiresOn, "2027-11-01");
});

test("a compliant certificate outranks a rejected one", () => {
  const f = evaluate(policy(), [evidence({ id: "bad", status: "rejected" }), evidence({ id: "good" })]);
  assert.equal(f.state, "compliant");
  assert.equal(f.recordId, "good");
});

// --- project scoping ------------------------------------------------------

test("project-specific evidence only counts on its own project", () => {
  const wrap = [evidence({ id: "wrap", projectId: "proj-a" })];
  assert.equal(evaluate(policy(), wrap, [], "proj-a").state, "compliant");
  assert.equal(evaluate(policy(), wrap, [], "proj-b").state, "missing");
  assert.equal(evaluate(policy(), wrap, [], null).state, "missing");
});

// --- waivers -------------------------------------------------------------

test("an unexpired waiver suppresses the block but not the fact", () => {
  const f = evaluate(policy(), [], [waiver()]);
  assert.equal(f.state, "waived");
  assert.equal(f.blocksPayment, false);
  assert.equal(f.waiverId, "wv-1");
  assert.deepEqual(f.reasons, ["no_evidence"]);
});

test("expired and revoked waivers do not suppress anything", () => {
  assert.equal(evaluate(policy(), [], [waiver({ expiresOn: "2026-06-01" })]).blocksPayment, true);
  assert.equal(evaluate(policy(), [], [waiver({ effectiveFrom: "2026-08-01", expiresOn: "2026-09-01" })]).blocksPayment, true);
  assert.equal(evaluate(policy(), [], [waiver({ revokedAt: "2026-06-15T00:00:00Z" })]).blocksPayment, true);
});

test("a project-scoped waiver does not release other projects", () => {
  const scoped = [waiver({ projectId: "proj-a" })];
  assert.equal(evaluate(policy(), [], scoped, "proj-a").state, "waived");
  assert.equal(evaluate(policy(), [], scoped, "proj-b").state, "missing");
});

test("a waiver never upgrades a passing state", () => {
  const f = evaluate(policy(), [evidence()], [waiver()]);
  assert.equal(f.state, "compliant");
  assert.equal(f.waiverId, "wv-1");
});

// --- enforcement levels --------------------------------------------------

test("enforcement decides what a failure does", () => {
  const missing = (enforcement: RequirementPolicy["enforcement"]) => evaluate(policy({ enforcement }), []);
  assert.deepEqual(
    ["advisory", "warn", "block_payment", "block_bill"].map((e) => {
      const f = missing(e as RequirementPolicy["enforcement"]);
      return [f.blocksBill, f.blocksPayment];
    }),
    [
      [false, false],
      [false, false],
      [false, true],
      // block_bill is strictly stronger: evidence that stops the bill being
      // recorded also stops its cash leaving.
      [true, true],
    ],
  );
});

// --- vendor roll-up ------------------------------------------------------

test("an unclassified vendor is not tracked and never blocks", () => {
  const status = evaluateVendorCompliance({
    partyId: "p1",
    classId: null,
    policies: [policy()],
    records: [],
    waivers: [],
    asOf: ASOF,
  });
  assert.equal(status.tracked, false);
  assert.deepEqual(status.findings, []);
  assert.equal(status.blocksPayment, false);
});

test("only policies for the vendor's class (or unscoped) apply", () => {
  const status = evaluateVendorCompliance({
    partyId: "p1",
    classId: "class-trade",
    policies: [
      policy({ id: "a", code: "GL", classId: "class-trade" }),
      policy({ id: "b", code: "W9", classId: null, requiresExpiry: false, category: "tax_form" }),
      policy({ id: "c", code: "PROF", classId: "class-consultant" }),
    ],
    records: [],
    waivers: [],
    asOf: ASOF,
  });
  assert.deepEqual(status.findings.map((f) => f.code), ["GL", "W9"]);
  assert.deepEqual(status.blockingCodes, ["GL", "W9"]);
});

test("the roll-up reports the worst state", () => {
  const status = evaluateVendorCompliance({
    partyId: "p1",
    classId: "class-trade",
    policies: [policy({ id: "a", code: "GL" }), policy({ id: "b", code: "WC" })],
    records: [evidence({ id: "r1", requirementId: "a" })],
    waivers: [],
    asOf: ASOF,
  });
  assert.equal(status.overall, "missing");
  assert.equal(status.blocksPayment, true);
});

// --- lien waivers --------------------------------------------------------

function lien(over: Partial<LienWaiverEvidence> = {}): LienWaiverEvidence {
  return {
    id: "lw-1",
    waiverNumber: "LW-0001",
    status: "signed",
    direction: "received",
    projectId: "proj-a",
    throughDate: "2026-06-30",
    amount: "50000.0000",
    currency: "USD",
    billDocumentId: null,
    ...over,
  };
}

const coverage = (over: Partial<Parameters<typeof evaluateLienWaiverCoverage>[0]> = {}) =>
  evaluateLienWaiverCoverage({
    enforcement: "block",
    projectId: "proj-a",
    billDocumentId: "bill-1",
    billDate: "2026-06-30",
    billAmount: "50000.0000",
    billCurrency: "USD",
    waivers: [lien()],
    ...over,
  });

test("a signed waiver reaching the bill date for the full amount releases it", () => {
  const c = coverage();
  assert.equal(c.covered, true);
  assert.equal(c.waiverNumber, "LW-0001");
  assert.equal(c.reason, "covered");
  assert.equal(c.blocksPayment, false);
});

test("no waiver on a blocking class blocks the release", () => {
  const c = coverage({ waivers: [] });
  assert.equal(c.covered, false);
  assert.equal(c.reason, "no_signed_waiver");
  assert.equal(c.blocksPayment, true);
});

test("an unsigned waiver is not a waiver", () => {
  for (const status of ["draft", "requested", "received", "rejected", "void"] as const) {
    assert.equal(coverage({ waivers: [lien({ status })] }).covered, false, status);
  }
});

test("a waiver that stops short of the bill date does not release it", () => {
  const c = coverage({ waivers: [lien({ throughDate: "2026-05-31" })] });
  assert.equal(c.reason, "through_date_short");
  assert.equal(c.coveredThrough, "2026-05-31");
});

test("a waiver for less than the bill leaves a stated shortfall", () => {
  const c = coverage({ waivers: [lien({ amount: "30000.0000" })] });
  assert.equal(c.reason, "amount_short");
  assert.equal(c.shortfall, "20000.0000");
});

test("a waiver in another currency is not a measurable release", () => {
  const c = coverage({ waivers: [lien({ currency: "CAD", amount: "999999.0000" })] });
  assert.equal(c.reason, "currency_mismatch");
  assert.equal(c.blocksPayment, true);
});

test("a waiver linked to the bill governs, even when a larger unlinked one exists", () => {
  const c = coverage({
    waivers: [
      lien({ id: "linked", waiverNumber: "LW-LINK", billDocumentId: "bill-1", amount: "10000.0000" }),
      lien({ id: "other", waiverNumber: "LW-OTHER", amount: "900000.0000" }),
    ],
  });
  assert.equal(c.covered, false);
  assert.equal(c.reason, "amount_short");
  assert.equal(c.shortfall, "40000.0000");
});

test("the tightest sufficient waiver is the one reported", () => {
  const c = coverage({
    waivers: [lien({ id: "big", waiverNumber: "LW-BIG", amount: "500000.0000" }), lien({ id: "fit", waiverNumber: "LW-FIT", amount: "50000.0000" })],
  });
  assert.equal(c.waiverNumber, "LW-FIT");
});

test("warn enforcement reports the gap without blocking; none skips the check", () => {
  assert.equal(coverage({ enforcement: "warn", waivers: [] }).blocksPayment, false);
  assert.equal(coverage({ enforcement: "warn", waivers: [] }).covered, false);
  const off = coverage({ enforcement: "none", waivers: [] });
  assert.equal(off.required, false);
  assert.equal(off.covered, true);
});

test("a bill with no project needs no lien waiver — there is no lien to waive", () => {
  const c = coverage({ projectId: null, waivers: [] });
  assert.equal(c.required, false);
  assert.equal(c.covered, true);
  assert.equal(c.reason, "not_required");
});

test("a waiver for another project does not release this one", () => {
  const c = coverage({ waivers: [lien({ projectId: "proj-b" })] });
  assert.equal(c.reason, "no_signed_waiver");
});

// --- bill release decision ----------------------------------------------

test("bill release combines insurance and lien-waiver control", () => {
  const bill = {
    documentId: "bill-1",
    documentNumber: "BILL-0001",
    partyId: "p1",
    vendorName: "Ace Framing",
    projectId: "proj-a",
    documentDate: "2026-06-30",
    amount: "50000.0000",
    currency: "USD",
  };
  const clear = evaluateBillRelease({
    bill,
    policies: [policy()],
    inputs: {
      classId: "class-trade",
      lienWaiverEnforcement: "block",
      records: [evidence()],
      waivers: [],
      lienWaivers: [lien()],
    },
    asOf: ASOF,
  });
  assert.equal(clear.decision, "cleared");
  assert.deepEqual(clear.reasons, []);

  const noWaiver = evaluateBillRelease({
    bill,
    policies: [policy()],
    inputs: { classId: "class-trade", lienWaiverEnforcement: "block", records: [evidence()], waivers: [], lienWaivers: [] },
    asOf: ASOF,
  });
  assert.equal(noWaiver.decision, "blocked");
  assert.ok(noWaiver.reasons.some((r) => r.startsWith("lien waiver")));

  const lapsed = evaluateBillRelease({
    bill,
    policies: [policy()],
    inputs: { classId: "class-trade", lienWaiverEnforcement: "none", records: [], waivers: [], lienWaivers: [] },
    asOf: ASOF,
  });
  assert.equal(lapsed.decision, "blocked");
  assert.ok(lapsed.reasons[0].includes("General Liability"));
});

test("a non-blocking failure warns instead of blocking, and advisory stays silent", () => {
  const bill = {
    documentId: "bill-1",
    documentNumber: "BILL-0001",
    partyId: "p1",
    vendorName: "Ace Framing",
    projectId: null,
    documentDate: "2026-06-30",
    amount: "1000.0000",
    currency: "USD",
  };
  const warned = evaluateBillRelease({
    bill,
    policies: [policy({ enforcement: "warn" })],
    inputs: { classId: "class-trade", lienWaiverEnforcement: "none", records: [], waivers: [], lienWaivers: [] },
    asOf: ASOF,
  });
  assert.equal(warned.decision, "warned");
  assert.equal(warned.reasons.length, 1);

  const advisory = evaluateBillRelease({
    bill,
    policies: [policy({ enforcement: "advisory" })],
    inputs: { classId: "class-trade", lienWaiverEnforcement: "none", records: [], waivers: [], lienWaivers: [] },
    asOf: ASOF,
  });
  assert.equal(advisory.decision, "cleared");
});

test("an untracked vendor's lien-waiver enforcement is not applied", () => {
  const decision = evaluateBillRelease({
    bill: {
      documentId: "bill-1",
      documentNumber: "BILL-0001",
      partyId: "p1",
      vendorName: "Big Box Supply",
      projectId: "proj-a",
      documentDate: "2026-06-30",
      amount: "50000.0000",
      currency: "USD",
    },
    policies: [policy()],
    // A stale class-level setting must not survive un-classifying the vendor.
    inputs: { classId: null, lienWaiverEnforcement: "block", records: [], waivers: [], lienWaivers: [] },
    asOf: ASOF,
  });
  assert.equal(decision.decision, "cleared");
  assert.equal(decision.lienWaiver.required, false);
});
