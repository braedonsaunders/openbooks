import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNativeDocumentKey,
  collisionSafeSourceDocumentNumber,
  effectiveSourceDocumentNumber,
  effectiveLineSubsidiary,
  effectiveTaxCodeId,
  needsStandalonePeriodRefresh,
  requiresControlledPostingReversal,
  verifyTargetedDocumentKeys,
  sourceDeletionCandidates,
  unresolvedSourceDeletionCandidates,
  syncVerificationFailures,
  verifyOpenItems,
  type SyncResult,
} from "./sync.ts";
import type { NativeDocument } from "./native.ts";
import type { ApplyStats } from "./applications.ts";
import { TTYPE_KIND } from "./netsuite-native.ts";
import { OPEN_ITEM_DOCUMENT_KINDS } from "./sync.ts";

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    runId: "run",
    kind: "incremental",
    docsNew: 0,
    docsAmended: 0,
    docsUnchanged: 1,
    ordersNew: 0,
    docsFailed: 0,
    sourceUnbuildable: 0,
    skipped: [],
    deletedAtSource: [],
    autoResolvedDeletions: [],
    applications: null,
    trueUp: null,
    tb: { accounts: 1, matches: 1, mismatches: [] },
    openItems: { checked: 1, matches: 1, mismatches: [] },
    periods: { checked: 1, matches: 1, mismatches: [] },
    projectPeriods: null,
    syncedThrough: "2026-07-20T00:00:00.000Z",
    durationMs: 1,
    ...overrides,
  };
}

test("financial cursor gate accepts only a completely proven run", () => {
  assert.deepEqual(syncVerificationFailures(result()), []);
});

test("a posted source transition requires a controlled reversal", () => {
  assert.equal(requiresControlledPostingReversal(false, true), true);
  assert.equal(requiresControlledPostingReversal(true, true), false);
  assert.equal(requiresControlledPostingReversal(false, false), false);
});

test("targeted verification certifies only exact requested documents", () => {
  assert.deepEqual(
    verifyTargetedDocumentKeys(
      [
        { sourceRef: "10", canonicalKey: "alpha" },
        { sourceRef: "20", canonicalKey: "bravo" },
        { sourceRef: "30", canonicalKey: "charlie" },
      ],
      new Map([
        ["10", "alpha"],
        ["20", "changed"],
      ]),
    ),
    {
      checked: 3,
      matches: 1,
      mismatches: [
        { sourceRef: "20", reason: "canonical_content" },
        { sourceRef: "30", reason: "missing_target" },
      ],
    },
  );
});

test("bounded repairs refresh exact source period identities without loading all entities", () => {
  assert.equal(needsStandalonePeriodRefresh(["102458"], false), true);
  assert.equal(needsStandalonePeriodRefresh(["102458"], true), false);
  assert.equal(needsStandalonePeriodRefresh([], false), false);
  assert.equal(needsStandalonePeriodRefresh(null, false), false);
});

test("financial cursor gate fails runs with unmatched or unallocated applications", () => {
  const stats = (overrides: Partial<ApplyStats> = {}) => ({
    pairs: 2,
    inserted: 1,
    insertedAmount: "50.0000",
    alreadySettled: 0,
    skippedNoLine: 0,
    unallocated: "0.0000",
    ...overrides,
  });
  // A fully settled run stays green, with or without application links.
  assert.deepEqual(syncVerificationFailures(result({ applications: stats() })), []);
  assert.deepEqual(syncVerificationFailures(result()), []);
  // Links no open line could settle are a run failure, not a silent ok —
  // otherwise money sits unsettled while the run reports success.
  assert.deepEqual(
    syncVerificationFailures(result({ applications: stats({ skippedNoLine: 2 }) })),
    ["2 settlement links could not be matched to open items"],
  );
  assert.deepEqual(
    syncVerificationFailures(result({ applications: stats({ unallocated: "50.0000" }) })),
    ["unallocated settlement amount 50.0000 could not be applied"],
  );
});

test("financial cursor gate reports every independent divergence", () => {
  assert.deepEqual(
    syncVerificationFailures(
      result({
        docsFailed: 2,
        sourceUnbuildable: 3,
        deletedAtSource: ["4"],
        tb: { accounts: 7, matches: 6, mismatches: [] },
        openItems: { checked: 9, matches: 7, mismatches: [] },
        periods: { checked: 12, matches: 8, mismatches: [] },
        projectPeriods: { checked: 20, matches: 14, mismatches: [] },
      }),
    ),
    [
      "2 transaction writes failed",
      "3 source transactions were unbuildable",
      "1 source deletions need resolution",
      "1 trial-balance accounts differ",
      "2 open items differ",
      "4 account-month buckets differ",
      "6 project-account-month buckets differ",
    ],
  );
});

test("full sweeps detect vanished source records while mirrors require tombstones", () => {
  const existing = ["1", "2", "3"];
  const current = ["1", "3", "4"];
  assert.deepEqual(
    sourceDeletionCandidates(true, existing, current, ["3", "9"]),
    ["2", "3"],
  );
  assert.deepEqual(
    sourceDeletionCandidates(false, existing, current, ["3", "9"]),
    ["3"],
  );
});

test("controller-resolved source deletions no longer block the cursor gate", () => {
  assert.deepEqual(
    unresolvedSourceDeletionCandidates(["657109", "other"], ["657109"]),
    ["other"],
  );
});

test("change detection treats an inherited line subsidiary as its header subsidiary", () => {
  assert.equal(effectiveLineSubsidiary(null, "root"), "root");
  assert.equal(effectiveLineSubsidiary("child", "root"), "child");
  assert.equal(effectiveLineSubsidiary(undefined, null), null);
});

test("zero tax ignores arbitrary rate-matched code identity during change detection", () => {
  assert.equal(effectiveTaxCodeId("0", "zero-tax-code"), null);
  assert.equal(effectiveTaxCodeId("0.0000", null), null);
  assert.equal(effectiveTaxCodeId("13.00", "hst-code"), "hst-code");
});

test("source display number is distinct from immutable source identity", () => {
  assert.equal(
    effectiveSourceDocumentNumber(
      canonicalDocument({
        sourceRef: "667706",
        documentNumber: "INV4194",
      }),
    ),
    "INV4194",
  );
  assert.equal(
    effectiveSourceDocumentNumber(
      canonicalDocument({ sourceRef: "667706", documentNumber: "  " }),
    ),
    "667706",
  );
});

test("colliding source display numbers retain visible and immutable identities", () => {
  assert.equal(
    collisionSafeSourceDocumentNumber(
      canonicalDocument({ sourceRef: "670369", documentNumber: "121284" }),
      "netsuite",
    ),
    "121284 [netsuite:670369]",
  );
  assert.equal(
    collisionSafeSourceDocumentNumber(
      canonicalDocument({ sourceRef: "670369", documentNumber: "  " }),
      "netsuite",
    ),
    "670369 [netsuite:670369]",
  );
});

const canonicalDocument = (
  overrides: Partial<NativeDocument> = {},
): NativeDocument => ({
  sourceRef: "source-1",
  kind: "customer_invoice",
  posting: true,
  partyId: "party",
  subsidiaryId: "subsidiary",
  currency: "CAD",
  fxRate: "1",
  documentDate: "2026-07-27",
  postingDate: "2026-07-27",
  postingPeriodId: "period-july",
  dueDate: "2026-08-27",
  memo: null,
  referenceNumber: "INV-1",
  controlAccountId: "ar",
  lines: [{
    accountId: "income",
    itemId: "item",
    quantity: "1",
    unit: "hour",
    unitPrice: "10",
    amount: "10",
    taxAmount: "0",
    taxOverridden: false,
    taxCodeId: null,
    departmentId: null,
    projectId: "project",
    description: "Labour",
    lineNumber: 1,
    sourceLineRef: "1",
  }],
  ...overrides,
});

test("change detection includes currency and exact exchange rate", () => {
  const baseline = canonicalNativeDocumentKey(canonicalDocument());
  assert.notEqual(
    baseline,
    canonicalNativeDocumentKey(canonicalDocument({ currency: "USD" })),
  );
  assert.notEqual(
    baseline,
    canonicalNativeDocumentKey(canonicalDocument({ fxRate: "1.00000001" })),
  );
});

test("change detection includes the exact accounting period", () => {
  const baseline = canonicalNativeDocumentKey(canonicalDocument());
  assert.notEqual(
    baseline,
    canonicalNativeDocumentKey(
      canonicalDocument({ postingPeriodId: "period-adjustment" }),
    ),
  );
});

test("change detection includes source commercial truth on every line", () => {
  const baselineDocument = canonicalDocument();
  const baselineLine = baselineDocument.lines[0]!;
  const baseline = canonicalNativeDocumentKey({
    ...baselineDocument,
    lines: [{
      ...baselineLine,
      isBillable: true,
      markupPercent: "15",
      billAmount: "11.5",
    }],
  });
  for (const line of [
    { ...baselineLine, isBillable: false, markupPercent: "15", billAmount: "11.5" },
    { ...baselineLine, isBillable: true, markupPercent: "12", billAmount: "11.5" },
    { ...baselineLine, isBillable: true, markupPercent: "15", billAmount: "10" },
  ]) {
    assert.notEqual(
      baseline,
      canonicalNativeDocumentKey({
        ...baselineDocument,
        lines: [line],
      }),
    );
  }
});

test("change detection includes non-posting commercial totals only", () => {
  const posting = canonicalDocument({ subtotal: "99", total: "99" });
  assert.equal(
    canonicalNativeDocumentKey(posting),
    canonicalNativeDocumentKey({
      ...posting,
      subtotal: "100",
      total: "100",
    }),
  );
  const order = canonicalDocument({
    posting: false,
    kind: "sales_order",
    subtotal: "99",
    total: "99",
  });
  assert.notEqual(
    canonicalNativeDocumentKey(order),
    canonicalNativeDocumentKey({
      ...order,
      subtotal: "100",
      total: "100",
    }),
  );
});

test("change detection includes source lifecycle for non-posting documents", () => {
  const pending = canonicalDocument({
    posting: false,
    kind: "expense_report",
    lifecycleStatus: "pending_approval",
  });
  assert.notEqual(
    canonicalNativeDocumentKey(pending),
    canonicalNativeDocumentKey({
      ...pending,
      lifecycleStatus: "approved",
    }),
  );
  const posting = canonicalDocument({ lifecycleStatus: "pending_approval" });
  assert.equal(
    canonicalNativeDocumentKey(posting),
    canonicalNativeDocumentKey({
      ...posting,
      lifecycleStatus: "approved",
    }),
  );
});

test("open-item verification distinguishes a closed zero balance from a missing document", () => {
  assert.deepEqual(
    verifyOpenItems(
      [
        { ref: "closed", unpaid: "0" },
        { ref: "open", unpaid: "-12.3400" },
      ],
      [
        { ref: "closed", unpaid: "0.0000" },
        { ref: "open", unpaid: "12.3400" },
      ],
    ),
    { checked: 2, matches: 2, mismatches: [] },
  );
  assert.deepEqual(verifyOpenItems([{ ref: "missing", unpaid: "0" }], []), {
    checked: 1,
    matches: 0,
    mismatches: [{ ref: "missing", ours: "missing", theirs: "0.0000" }],
  });
});

test("open-item verification flags a nonzero balance the source never lists", () => {
  assert.deepEqual(
    verifyOpenItems(
      [{ ref: "a", unpaid: "10.0000" }],
      [
        { ref: "a", unpaid: "10.0000" },
        { ref: "ghost", unpaid: "500.0000" },
      ],
    ),
    {
      checked: 2,
      matches: 1,
      mismatches: [{ ref: "ghost", ours: "500.0000", theirs: "not_in_source" }],
    },
  );
});

test("open-item verification ignores a zero balance the source no longer reports", () => {
  // A closed, paid, or voided document the source omits is complete, not
  // divergent: its stored balance is already exactly zero.
  assert.deepEqual(
    verifyOpenItems(
      [{ ref: "a", unpaid: "10.0000" }],
      [
        { ref: "a", unpaid: "10.0000" },
        { ref: "paid", unpaid: "0.0000" },
        { ref: "voided", unpaid: "0" },
      ],
    ),
    { checked: 1, matches: 1, mismatches: [] },
  );
});

test("open-item verification compares every kind the NetSuite truth query lists", () => {
  // netsuite-source.openItems() selects CustInvc, VendBill and ExpRept plus the
  // two credit types. Every one must map to a kind the local comparison
  // selects, or a clean ledger fails the financial gate with thousands of
  // "missing" refs (2026-09-14: 9,109 expense reports).
  const truthTypes = ["CustInvc", "VendBill", "ExpRept", "VendCred", "CustCred"];
  const compared = new Set<string>(OPEN_ITEM_DOCUMENT_KINDS);
  for (const type of truthTypes) {
    const kind = TTYPE_KIND[type];
    assert.ok(kind, `${type} has no native kind`);
    assert.ok(compared.has(kind), `${type} → ${kind} is not compared against open-item truth`);
  }
});

test("open-item verification sums duplicate target refs instead of hiding a double import", () => {
  // Two local documents carrying the same source ref (a double import nothing
  // forbids) must read as a divergence: collapsing to the last row reports a
  // clean match on a doubled ledger. Summing is also order-independent where
  // last-wins is not — a voided duplicate at zero plus the live document
  // still ties exactly.
  assert.deepEqual(
    verifyOpenItems(
      [{ ref: "inv", unpaid: "100.0000" }],
      [
        { ref: "inv", unpaid: "100.0000" },
        { ref: "inv", unpaid: "100.0000" },
      ],
    ),
    {
      checked: 1,
      matches: 0,
      mismatches: [{ ref: "inv", ours: "200.0000", theirs: "100.0000" }],
    },
  );
  assert.deepEqual(
    verifyOpenItems(
      [{ ref: "inv", unpaid: "100.0000" }],
      [
        { ref: "inv", unpaid: "0.0000" },
        { ref: "inv", unpaid: "100.0000" },
      ],
    ),
    { checked: 1, matches: 1, mismatches: [] },
  );
});

test("change detection ignores source cleared evidence on native lines", () => {
  // Cleared/reconciled markers are evidence about the source's books, not
  // commercial content: a clear-flip must never amend or re-post the
  // document. The mirror stamps it onto the posted journal lines out of
  // band, so the canonical key must be blind to it.
  const baseline = canonicalDocument();
  const baselineKey = canonicalNativeDocumentKey(baseline);
  const line = baseline.lines[0]!;
  assert.equal(
    baselineKey,
    canonicalNativeDocumentKey({
      ...baseline,
      lines: [{ ...line, sourceCleared: true, sourceClearedDate: "2026-08-31" }],
    }),
  );
  assert.equal(
    baselineKey,
    canonicalNativeDocumentKey({
      ...baseline,
      lines: [{ ...line, sourceCleared: false, sourceClearedDate: null }],
    }),
  );
});
