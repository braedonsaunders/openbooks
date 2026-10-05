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
import type { Money } from "../../money/brands.ts";
import {
  ehtExemptionConsumedByRunStatus,
  levyAssessableBase,
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

type BaseLine = {
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  amount: Money;
  accrualOnly?: boolean;
  programApplicability?: Record<string, boolean>;
};

const earning = (amount: string, programApplicability?: Record<string, boolean>): BaseLine => ({
  kind: "earning",
  amount: amount as Money,
  programApplicability,
});

test("the assessable base sums assessable earning lines only", () => {
  // Wages 1,000.00, a 70.00 excluded per-diem, a 5.00 taxable benefit with
  // no exclusions, a 90.00 excluded health premium, plus a deduction and an
  // accrual-only earning that never count.
  const lines: BaseLine[] = [
    earning("1000.00"),
    earning("70.00", { wcb: false, eht: false }),
    earning("5.00"),
    earning("90.00", { wcb: false, eht: false }),
    { kind: "deduction", amount: "40.00" as Money },
    { kind: "earning", amount: "12.00" as Money, accrualOnly: true },
  ];
  assert.equal(levyAssessableBase(lines, "wcb"), "1005.0000");
  assert.equal(levyAssessableBase(lines, "eht"), "1005.0000");
});

test("an exclusion for one levy leaves the other levies assessable", () => {
  // The retiring-allowance shape: excluded from workers' compensation,
  // assessable for health tax.
  const lines: BaseLine[] = [
    earning("1000.00"),
    earning("200.00", { wcb: false }),
  ];
  assert.equal(levyAssessableBase(lines, "wcb"), "1000.0000");
  assert.equal(levyAssessableBase(lines, "eht"), "1200.0000");
});

test("absent applicability means assessable: only stamped exclusions remove a line", () => {
  const lines: BaseLine[] = [
    earning("1000.00"),
    earning("200.00", { eht: false }),
  ];
  assert.equal(levyAssessableBase(lines, "wcb"), "1200.0000");
  assert.equal(levyAssessableBase(lines, "eht"), "1000.0000");
});
