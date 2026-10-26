import assert from "node:assert/strict";
import test from "node:test";
import { sourceSupportsRunMode, validateTargetedRepairSourceRefs } from "./run-modes.ts";

test("targeted repairs retain exact text identities and admit only the supporting connector", () => {
  const input = ["722205", "723659"];
  const refs = validateTargetedRepairSourceRefs(input);
  assert.deepEqual(refs, input);
  assert.notEqual(refs, input);
  assert.equal(sourceSupportsRunMode("netsuite", "targeted_repair"), true);
  assert.equal(sourceSupportsRunMode("csv", "targeted_repair"), false);
});

test("targeted repairs refuse missing, ambiguous, repeated or overlength source sets", () => {
  for (const value of [
    undefined,
    null,
    [],
    ["1", "1"],
    [1],
    [" 1"],
    ["1 "],
    ["01"],
    ["0"],
    ["-1"],
    ["1.0"],
    ["1,2"],
    Array.from({ length: 501 }, (_, n) => String(n + 1)),
  ]) {
    assert.throws(() => validateTargetedRepairSourceRefs(value));
  }
  assert.equal(
    validateTargetedRepairSourceRefs(Array.from({ length: 500 }, (_, n) => String(n + 1))).length,
    500,
  );
});
