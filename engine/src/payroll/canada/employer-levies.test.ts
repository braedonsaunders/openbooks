/**
 * EHT exemption lifecycle test — the exhaustive switch in
 * `ehtExemptionConsumedByRunStatus` (engine/src/payroll/canada/employer-levies.ts).
 *
 * Pure unit test: every `pay_runs.run_status` state must name its side, and
 * only `committed` consumes exemption room for other runs. A new lifecycle
 * state breaks the switch's compile (the `never` default), and this test
 * names the four states so the behaviour change is deliberate, never a
 * silent inheritance.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ehtExemptionConsumedByRunStatus,
  type CaExemptionRunStatus,
} from "./employer-levies.ts";

test("only committed runs consume the EHT exemption for other runs", () => {
  const cases: readonly (readonly [CaExemptionRunStatus, boolean])[] = [
    ["draft", false],
    ["calculated", false],
    ["committed", true],
    ["voided", false],
  ];
  assert.equal(cases.length, 4, "every lifecycle state is named here");
  for (const [status, expected] of cases) {
    assert.equal(ehtExemptionConsumedByRunStatus(status), expected, status);
  }
});
