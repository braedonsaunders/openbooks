import assert from "node:assert/strict";
import test from "node:test";
import { allocationFingerprint } from "./period-run.ts";
import type { RunComputation } from "./types.ts";

function computation(over: Partial<RunComputation> = {}): RunComputation {
  return {
    ruleId: "rule-1",
    versionId: "version-1",
    definitionHash: "hash-1",
    periodId: "period-1",
    bookId: "book-1",
    sourceMeasure: "period_activity",
    sources: [],
    sourceTotal: "1000.0000",
    driver: {
      id: "drv-1",
      key: "drv",
      asOf: { periodId: "period-1" },
      vector: [{ key: "a", value: "1000.0000" }],
    },
    targets: [],
    lines: [],
    residualPolicy: "largest_share",
    impact: "reclass",
    ...over,
  };
}

test("the temporal echo never moves the fingerprint (rerun idempotence survives it)", () => {
  const before = computation();
  const after = computation({
    driver: {
      id: "drv-1",
      key: "drv",
      asOf: { periodId: "period-1" },
      vector: [{ key: "a", value: "1000.0000" }],
      temporal: { mode: "period_activity", from: "2026-07-01", to: "2026-07-31", field: "posting_date" },
    },
  });
  assert.equal(allocationFingerprint(before), allocationFingerprint(after));
});

test("economic changes still move the fingerprint", () => {
  const base = allocationFingerprint(computation());
  assert.notEqual(allocationFingerprint(computation({ sourceTotal: "999.0000" })), base);
  assert.notEqual(
    allocationFingerprint(
      computation({
        driver: {
          id: "drv-1",
          key: "drv",
          asOf: { periodId: "period-1" },
          vector: [{ key: "a", value: "500.0000" }],
        },
      }),
    ),
    base,
  );
});
