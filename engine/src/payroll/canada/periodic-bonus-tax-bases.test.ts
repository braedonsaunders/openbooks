import {
  assessedCanadianWages,
  type CanadianWageScenario,
} from "../../testing/payroll-canadian-wages.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp, neg } from "../../money/money.ts";
import { calculateT4127 } from "./t4127.ts";

const subtract = (left: string, right: string) => add(left, neg(right));

const monthly: CanadianWageScenario = {
  payDate: "2026-03-31",
  province: "ON",
  periodsPerYear: 12,
  income: "5000",
  cppExempt: true,
  eiExempt: true,
};

for (const province of ["ON", "NS", "QC"] as const) {
  test(`Option 1 ${province} regular withholding excludes previously taxed bonuses without changing premiums`, () => {
    const input: CanadianWageScenario = {
      payDate: "2026-07-17",
      province,
      periodsPerYear: 52,
      income: "2000",
      pensionable: "2000",
      insurable: "2000",
      ytd: { cpp: "2500", cpp2: "0", ei: "500", pensionable: "42000" },
    };
    const regular = calculateT4127(assessedCanadianWages(input));
    const afterBonus = calculateT4127(
      assessedCanadianWages({
        ...input,
        ytd: {
          ...input.ytd,
          nonPeriodic: "30000",
          nonPeriodicPensionDeductions: "1000",
          nonPeriodicCppEnhancedDeductions: "300",
        },
      }),
    );
    assert.equal(afterBonus.periodicTax, regular.periodicTax);
    assert.equal(afterBonus.totalTax, regular.totalTax);
    assert.equal(afterBonus.bonusTax, "0.0000");
    assert.equal(afterBonus.factors.A, regular.factors.A);
    assert.equal(afterBonus.factors.A_periodic, regular.factors.A);
    assert.equal(subtract(afterBonus.factors.A_step2!, afterBonus.factors.A!), "28700.0000");
    for (const key of [
      "cpp",
      "cpp2",
      "cppEmployer",
      "ei",
      "eiEmployer",
      "qpip",
      "qpipEmployer",
      "f5A",
      "f5B",
    ] as const) {
      assert.equal(afterBonus[key], regular[key]);
    }
  });
}

test("Option 1 mixed pay uses periodic annual income for regular tax and prior bonuses only for the bonus difference", () => {
  const regular = calculateT4127(assessedCanadianWages(monthly));
  const mixed = calculateT4127(
    assessedCanadianWages({ ...monthly, nonPeriodic: "1000", ytd: { nonPeriodic: "10000" } }),
  );
  assert.equal(mixed.periodicTax, regular.periodicTax);
  assert.equal(mixed.bonusTax, "296.5000");
  assert.equal(subtract(mixed.totalTax, mixed.periodicTax), mixed.bonusTax);
  assert.equal(mixed.factors.A_periodic, "60000.0000");
  assert.equal(mixed.factors.A_step2, "70000.0000");
  assert.equal(mixed.factors.A_bonus, "71000.0000");
  assert.equal(mixed.factors.T1_periodic, regular.factors.T1);
  assert.equal(mixed.factors.T2_periodic, regular.factors.T2);
});

test("Option 1 separately paid bonus cannot create regular tax from earlier bonuses when current periodic income is zero", () => {
  const separate = calculateT4127(
    assessedCanadianWages({
      ...monthly,
      income: "0",
      nonPeriodic: "1000",
      ytd: { nonPeriodic: "10000" },
      additionalTaxPerPeriod: "25",
    }),
  );
  assert.equal(separate.periodicTax, "25.0000");
  assert.equal(separate.factors.A_periodic, "0.0000");
  assert.equal(separate.factors.T1_periodic, "0.0000");
  assert.equal(separate.factors.T2_periodic, "0.0000");
  assert.equal(subtract(separate.totalTax, separate.bonusTax), "25.0000");
});

test("Option 1 periodic and bonus passes resolve their own income-phased claims", () => {
  const input: CanadianWageScenario = { ...monthly, periodsPerYear: 52, income: "3000" };
  const regular = calculateT4127(assessedCanadianWages(input));
  const mixed = calculateT4127(
    assessedCanadianWages({ ...input, nonPeriodic: "100000", ytd: { nonPeriodic: "200000" } }),
  );
  assert.equal(mixed.periodicTax, regular.periodicTax);
  assert.equal(mixed.factors.TC_periodic, regular.factors.TC);
  assert.equal(mixed.factors.T1_periodic, regular.factors.T1);
  assert.ok(cmp(mixed.factors.TC_periodic!, mixed.factors.TC!) > 0);
  assert.ok(cmp(mixed.bonusTax, "0") > 0);
});

const averaging: NonNullable<CanadianWageScenario["averaging"]> = {
  elapsedPeriods: 2,
  income: "5000",
  pensionDeductions: "0",
  alimonyDeductions: "0",
  unionDues: "0",
  f5A: "0",
  pensionablePeriodic: "0",
  insurablePeriodic: "0",
  qpipPeriodic: "0",
  pensionableNonPeriodic: "0",
  insurableNonPeriodic: "0",
  qpipNonPeriodic: "0",
  periodicTax: "200",
  bonusTax: "3000",
};

test("Option 2 retains prior bonus income and subtracts its M1 withholding exactly once", () => {
  const input: CanadianWageScenario = { ...monthly, averaging, ytd: { nonPeriodic: "10000" } };
  const withHistory = calculateT4127(assessedCanadianWages(input));
  const withoutBonusTaxHistory = calculateT4127(
    assessedCanadianWages({ ...input, averaging: { ...averaging, bonusTax: "0" } }),
  );
  assert.equal(withHistory.factors.A_periodic, "70000.0000");
  assert.equal(withHistory.factors.A, "70000.0000");
  assert.equal(withHistory.factors.M, "200.0000");
  assert.equal(withHistory.factors.M1, "3000.0000");
  assert.equal(withHistory.factors.TB, "0.0000");
  // S1=12/2: removing previously paid M1=3000 changes this period by 500.
  assert.equal(subtract(withoutBonusTaxHistory.periodicTax, withHistory.periodicTax), "500.0000");
});

test("changing from cumulative averaging to Option 1 preserves bonus history without using it as periodic income", () => {
  const cumulative = calculateT4127(
    assessedCanadianWages({ ...monthly, averaging, ytd: { nonPeriodic: "10000" } }),
  );
  const regular = calculateT4127(
    assessedCanadianWages({ ...monthly, ytd: { nonPeriodic: "10000" } }),
  );
  assert.equal(cumulative.factors.A_periodic, "70000.0000");
  assert.equal(regular.factors.A_periodic, "60000.0000");
  assert.equal(regular.periodicTax, calculateT4127(assessedCanadianWages(monthly)).periodicTax);
  assert.equal(regular.factors.B1, cumulative.factors.B1);
  assert.equal(regular.factors.M, undefined);
  assert.equal(regular.factors.M1, undefined);
});
