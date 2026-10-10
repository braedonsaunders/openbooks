import assert from "node:assert/strict";
import test from "node:test";
import { listFlowSubjectProfiles } from "./registry.ts";
import { payRunSubjectProfile } from "./pay-runs-adapter.ts";

/**
 * The record-type picker offers each subject kind once. A kind with a
 * dedicated profile (pay runs carry payroll's own vocabulary) must not also
 * appear as a generic document profile: the duplicate rendered two identical
 * "Pay run" options, and profile resolution (first match wins) shadowed the
 * dedicated vocabulary behind the generic one.
 */
test("flow subject profiles carry each subject kind exactly once", () => {
  const kinds = listFlowSubjectProfiles().map((profile) => profile.subjectKind);
  assert.ok(kinds.length > 0);
  assert.deepEqual([...new Set(kinds)].sort(), [...kinds].sort());
});

test("the pay run entry is payroll's dedicated profile", () => {
  const entries = listFlowSubjectProfiles().filter(
    (profile) => profile.subjectKind === "pay_run",
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], payRunSubjectProfile);
  assert.ok(entries[0]?.fields.some((field) => field.key === "runType"));
  assert.ok(entries[0]?.fields.some((field) => field.key === "grossTotal"));
});
