import assert from "node:assert/strict";
import test from "node:test";
import { taskMeasures } from "./progress.ts";

test("earned value follows percent complete over the budget, in exact decimals", () => {
  const measures = taskMeasures("120.0000", "45.0000", "0.2500");
  assert.equal(measures.earned, "30.0000");
  assert.equal(measures.remaining, "75.0000");
  assert.equal(measures.hoursUsed, "0.3750");
  assert.equal(measures.performanceFactor, "0.6667");
  // 45 hours bought a quarter of the work: three more quarters at that pace.
  assert.equal(measures.hoursToComplete, "135.0000");
  assert.equal(measures.estimateAtCompletion, "180.0000");
  assert.equal(measures.varianceAtCompletion, "-60.0000");
});

test("a measure whose inputs are missing is unknown rather than zero", () => {
  const unbudgeted = taskMeasures(null, "10.0000", "0.5000");
  assert.equal(unbudgeted.earned, null);
  assert.equal(unbudgeted.hoursUsed, null);
  assert.equal(unbudgeted.varianceAtCompletion, null);
  assert.equal(unbudgeted.hoursToComplete, "10.0000");
  const unstarted = taskMeasures("40.0000", "0.0000", "0.0000");
  assert.equal(unstarted.performanceFactor, null);
  assert.equal(unstarted.hoursToComplete, null);
  const finished = taskMeasures("40.0000", "38.0000", "1.0000");
  assert.equal(finished.hoursToComplete, "0.0000");
  assert.equal(finished.varianceAtCompletion, "2.0000");
});
