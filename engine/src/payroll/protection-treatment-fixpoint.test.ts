/**
 * The protection fixpoint still converges when a treatment moves the
 * statutory pass (unit partition).
 *
 * A protected order that is ALSO pre-tax cannot settle in one pass: capping
 * it raises taxable income, which lowers net, which lowers the cap. This
 * drives the REAL `settleDeductionProtection` loop from payroll-run.ts with
 * a statutory pass wired exactly like production — PAYG re-derived every
 * pass from the deductions the pass takes (generic `reduceTaxBases` over the
 * AU vocabulary plus the transcribed Schedule 1 engine), SG pushed once and
 * never re-derived — and proves the loop settles instead of oscillating or
 * throwing after PROTECTION_MAX_PASSES.
 *
 * The scenario is deliberately harsh: a $2,000 salary-sacrifice request
 * against $3,653.85 gross with a 50%-of-net cap, so protection binds hard
 * and the first pass's withholding is priced on a wildly different base
 * from the last pass's.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../money/money.ts";
import { AU_PAYROLL_PACK } from "./au/pack.ts";
import { calculateAu2027 } from "./au/compute-statutory.ts";
import { reduceTaxBases } from "./treatment-bases.ts";
import { settleDeductionProtection } from "./run-protection.ts";
import { type Line } from "./run-stub-records.ts";

const GROSS = "3653.8500";

function paygFor(sacrifice: string): string {
  const reduced = reduceTaxBases(
    [{ kind: "deduction", amount: sacrifice, taxTreatment: "salary_sacrifice" }],
    { income: GROSS, nonPeriodic: "0.0000", pensionable: GROSS, insurable: GROSS },
    AU_PAYROLL_PACK.deductionTreatments,
  );
  return calculateAu2027({
    income: reduced.income,
    residency: "australian_resident",
    workingHolidayMaker: false,
    claimsThreshold: true,
    medicareExemption: "none",
    tfnQuoted: true,
    stslDebt: false,
    pensionable: GROSS,
    periodsPerYear: 26,
  }).payg;
}

test("a protected pre-tax sacrifice converges with tax priced on the capped amount", async () => {
  const lines: Line[] = [
    {
      componentId: "earn",
      kind: "earning",
      description: "Salary",
      amount: GROSS,
      sequence: 10,
      taxable: true,
      pensionable: true,
    },
    {
      componentId: "sac",
      kind: "deduction",
      description: "Salary sacrifice",
      amount: "2000.0000",
      sequence: 300,
      taxTreatment: "salary_sacrifice",
      protectionBase: "net_pay",
      protectionMaxPercent: "50",
      protectionPriority: 100,
    },
  ];
  // Earnings-assessed SG: pushed once, never re-derived — like production.
  lines.push({
    componentId: "sg",
    kind: "employer_contribution",
    description: "Superannuation guarantee",
    amount: "438.4600",
    sequence: 210,
    assessedOn: "earnings",
  });

  // Production-shaped statutory pass: drop the income-assessed PAYG line,
  // re-derive it from the deductions this pass takes.
  const runStatutoryPass = async (): Promise<void> => {
    const at = lines.findIndex((line) => line.assessedOn === "taxable_income");
    if (at >= 0) lines.splice(at, 1);
    const sacrifice = lines.find((line) => line.componentId === "sac")!.amount;
    lines.push({
      componentId: "payg",
      kind: "deduction",
      description: "PAYG withholding",
      amount: paygFor(sacrifice),
      sequence: 110,
      assessedOn: "taxable_income",
    });
  };

  // Throws after PROTECTION_MAX_PASSES when the loop cannot settle — so
  // returning at all IS the convergence proof; the assertions below pin
  // WHAT it settled on.
  const { protectedLines, protectionRequested } = await settleDeductionProtection({
    lines,
    gross: GROSS,
    employeeLabel: "Test Employee",
    packTreatments: AU_PAYROLL_PACK.deductionTreatments,
    runStatutoryPass,
  });

  assert.deepEqual(protectionRequested, ["2000.0000"]);
  const finalSacrifice = protectedLines[0]!.amount;
  assert.ok(cmp(finalSacrifice, "2000.0000") < 0, "protection binds: the request is capped");
  assert.ok(cmp(finalSacrifice, "0.0000") > 0, "a capped order still deducts something");

  const paygLine = lines.find((line) => line.componentId === "payg")!;
  assert.equal(
    paygLine.amount,
    paygFor(finalSacrifice),
    "the settled withholding is priced on the capped sacrifice actually deducted",
  );
  const sgLine = lines.find((line) => line.componentId === "sg")!;
  assert.equal(sgLine.amount, "438.4600", "SG never moves across fixpoint passes");
});
