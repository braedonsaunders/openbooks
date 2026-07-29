import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNativeDocumentKey,
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
  assert.equal(effectiveTaxCodeId("0", "legacy-zero-code"), null);
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
