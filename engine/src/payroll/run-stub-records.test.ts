/**
 * Per-program line applicability, stamped from the component's
 * `program_exclusions` (0342, C-13).
 *
 * The contract: an earning type feeds every declared contribution program
 * EXCEPT the excluded keys, so EI-excluded-but-QPIP-insurable earnings (or
 * the reverse) accumulate each program's OWN base in run-stub-compute —
 * never one program's base approximated from another's. Empty or absent
 * exclusions stamp nothing (the accumulation's default-true includes the
 * line); keys no pack declares are inert, exactly like an undeclared tax
 * treatment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { programApplicabilityFromExclusions } from "./run-stub-records.ts";

test("empty, absent, and non-array exclusions stamp nothing", () => {
  assert.equal(programApplicabilityFromExclusions(undefined), undefined);
  assert.equal(programApplicabilityFromExclusions(null), undefined);
  assert.equal(programApplicabilityFromExclusions([]), undefined);
  assert.equal(programApplicabilityFromExclusions("qpip"), undefined);
});

test("excluded program keys stamp false, everything else stays default-included", () => {
  assert.deepEqual(programApplicabilityFromExclusions(["qpip"]), { qpip: false });
  assert.deepEqual(
    programApplicabilityFromExclusions(["qpip", "cpp2x"]),
    { qpip: false, cpp2x: false },
  );
});

test("blank and non-string entries are ignored, never stamped", () => {
  assert.equal(programApplicabilityFromExclusions(["", 7, null]), undefined);
  assert.deepEqual(programApplicabilityFromExclusions(["qpip", ""]), { qpip: false });
});
