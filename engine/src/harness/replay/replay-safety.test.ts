import assert from "node:assert/strict";
import test from "node:test";
import { rebuildPasses } from "./rebuild.ts";

// A diagnostic GL fallback is not a successful native rebuild: the report
// must fail whenever anything fell back. Same predicate rebuildDataset uses,
// so this fails when the rule weakens. (Replay CLI sim guards are covered
// behaviorally in engine/src/sim/db-guard.test.ts.)
test("a diagnostic GL fallback can never produce a passing replay report", () => {
  const clean = { fallbacks: [], hardFailures: [], trialBalanceDiffs: [], openBalanceDiffs: [], projectDiffs: [] };
  assert.equal(rebuildPasses(clean, true), true);
  assert.equal(rebuildPasses({ ...clean, fallbacks: [{ event: "e1", kind: "invoice", reason: "native post failed" }] }, true), false);
});
