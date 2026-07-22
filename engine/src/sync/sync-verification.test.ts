import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveLineSubsidiary,
  effectiveTaxCodeId,
  sourceDeletionCandidates,
  unresolvedSourceDeletionCandidates,
  syncVerificationFailures,
  verifyOpenItems,
  type SyncResult,
} from "./sync.ts";

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
    applications: null,
    trueUp: null,
    tb: { accounts: 1, matches: 1, mismatches: [] },
    openItems: { checked: 1, matches: 1, mismatches: [] },
    periods: { checked: 1, matches: 1, mismatches: [] },
    syncedThrough: "2026-07-20T00:00:00.000Z",
    durationMs: 1,
    ...overrides,
  };
}

test("financial cursor gate accepts only a completely proven run", () => {
  assert.deepEqual(syncVerificationFailures(result()), []);
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
      }),
    ),
    [
      "2 transaction writes failed",
      "3 source transactions were unbuildable",
      "1 source deletions need resolution",
      "1 trial-balance accounts differ",
      "2 open items differ",
      "4 account-month buckets differ",
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
