import assert from "node:assert/strict";
import test from "node:test";
import { syncVerificationFailures, type SyncResult } from "./sync.ts";

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
  assert.deepEqual(syncVerificationFailures(result({
    docsFailed: 2,
    sourceUnbuildable: 3,
    deletedAtSource: ["4"],
    tb: { accounts: 7, matches: 6, mismatches: [] },
    openItems: { checked: 9, matches: 7, mismatches: [] },
    periods: { checked: 12, matches: 8, mismatches: [] },
  })), [
    "2 transaction writes failed",
    "3 source transactions were unbuildable",
    "1 source deletions need resolution",
    "1 trial-balance accounts differ",
    "2 open items differ",
    "4 account-month buckets differ",
  ]);
});
