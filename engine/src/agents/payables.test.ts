import test from "node:test";
import assert from "node:assert/strict";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import {
  payablesFindings,
  type DiscountOpportunityRow,
  type DuplicateBillPair,
  type PayablesLoaders,
  type PayrunBillRow,
  type StaleApprovalRow,
} from "./payables.ts";

function policies() {
  return defaultContinuousCloseDetectors("payables");
}

function stubLoaders(overrides: Partial<PayablesLoaders> = {}): PayablesLoaders {
  return {
    today: async () => "2026-09-16",
    duplicatePairs: async () => [],
    payrunBills: async () => ({ due: [], beyondCount: 0, beyondTotal: "0.0000" }),
    discountOpportunities: async () => [],
    staleApprovals: async () => [],
    ...overrides,
  };
}

const ORG = "00000000-0000-0000-0000-000000000002";

function pair(overrides: Partial<DuplicateBillPair> = {}): DuplicateBillPair {
  return {
    openDocId: "open-1",
    openDocNumber: "BILL-1",
    otherDocId: "other-1",
    otherDocNumber: "BILL-1-DUP",
    kind: "vendor_bill",
    openDate: "2026-09-01",
    otherDate: "2026-09-05",
    daysBetween: 4,
    amount: "1200.0000",
    openBalance: "1200.0000",
    otherOpenBalance: "0.0000",
    otherIsOpen: false,
    partyId: "v1",
    partyName: "Vendor One",
    sameMemo: true,
    ...overrides,
  };
}

test("duplicate pairs surface once with memo confidence and exact exposure", async () => {
  const loaders = stubLoaders({ duplicatePairs: async () => [pair()] });
  const findings = await payablesFindings(ORG, "1000.0000", policies(), loaders);
  const dups = findings.filter((finding) => finding.findingType === "duplicate_bills");
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.fingerprint, "payables-duplicates");
  assert.equal(dups[0]!.materiality, "1200.0000");
  assert.equal(dups[0]!.confidence, "0.9000", "same memo raises confidence");
  assert.equal(dups[0]!.severity, "warning", "one pair is not critical");
  assert.equal(dups[0]!.proposal ?? null, null, "no pay-run tool exists: the finding is the review card");
});

test("five pairs trip the critical count at the exact boundary", async () => {
  const pairs = Array.from({ length: 5 }, (_, index) =>
    pair({ openDocId: `open-${index}`, otherDocId: `other-${index}`, sameMemo: false }),
  );
  const loaders = stubLoaders({ duplicatePairs: async () => pairs });
  const findings = await payablesFindings(ORG, "1000.0000", policies(), loaders);
  const dups = findings.filter((finding) => finding.findingType === "duplicate_bills");
  assert.equal(dups[0]!.severity, "critical");
  assert.equal(dups[0]!.confidence, "0.7500");
  assert.equal(dups[0]!.materiality, "6000.0000", "open legs sum once each");
});

test("pay-run card orders oldest-due first and counts the deferred tail", async () => {
  const due: PayrunBillRow[] = [
    { docId: "n", docNumber: "N", partyId: "v", partyName: "V", dueDate: "2026-09-18", openBalance: "300.0000" },
    { docId: "o", docNumber: "O", partyId: "v", partyName: "V", dueDate: "2026-09-10", openBalance: "700.0000" },
  ];
  const loaders = stubLoaders({
    payrunBills: async (_orgId, horizonEnd) => {
      assert.equal(horizonEnd, "2026-09-23", "today plus the 7-day pay-run horizon");
      return { due, beyondCount: 4, beyondTotal: "9000.0000" };
    },
  });
  const findings = await payablesFindings(ORG, "1000.0000", policies(), loaders);
  const runs = findings.filter((finding) => finding.findingType === "bills_due_before_payrun");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.materiality, "1000.0000");
  const recommended = runs[0]!.summary.recommended as { documentId: string }[];
  assert.deepEqual(recommended.map((bill) => bill.documentId), ["n", "o"], "loader order (oldest first) is preserved verbatim");
  assert.equal(runs[0]!.summary.beyondHorizonCount, 4);
});

test("discounts group by term and skip sub-floor value", async () => {
  const rows: DiscountOpportunityRow[] = [
    { termId: "t1", termName: "2/10 net 30", discountPercent: "2.0000", discountDays: 10, docId: "a", docNumber: "A", partyName: "V", documentDate: "2026-09-10", openBalance: "100000.0000", discountValue: "2000.0000" },
    { termId: "t2", termName: "1/10 net 30", discountPercent: "1.0000", discountDays: 10, docId: "b", docNumber: "B", partyName: "W", documentDate: "2026-09-10", openBalance: "50000.0000", discountValue: "500.0000" },
  ];
  const loaders = stubLoaders({ discountOpportunities: async () => rows });
  const findings = await payablesFindings(ORG, "1000.0000", policies(), loaders);
  const discounts = findings.filter((finding) => finding.findingType === "early_pay_discount_opportunity");
  assert.equal(discounts.length, 1, "the $500 term stays below the floor");
  assert.equal(discounts[0]!.fingerprint, "payables-discount:t1");
  assert.equal(discounts[0]!.materiality, "2000.0000");
});

test("stalled approvals stay silent until the stale cutoff bites", async () => {
  const rows: StaleApprovalRow[] = [
    { docId: "s1", docNumber: "S1", kind: "vendor_bill", partyName: "V", documentDate: "2026-09-01", status: "pending_approval", total: "5000.0000" },
  ];
  let seenCutoff: string | null = null;
  const loaders = stubLoaders({
    staleApprovals: async (_orgId, cutoff) => {
      seenCutoff = cutoff;
      return rows;
    },
  });
  const findings = await payablesFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(seenCutoff, "2026-09-09", "today minus the 7-day stale window");
  const approvals = findings.filter((finding) => finding.findingType === "bills_missing_approval");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.materiality, "5000.0000");
});
