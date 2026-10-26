import {
  assessedCanadianWages,
  type CanadianWageScenario,
} from "../../testing/payroll-canadian-wages.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { calculateT4127 } from "./t4127.ts";

const payment: CanadianWageScenario = {
  payDate: "2026-06-15",
  province: "ON",
  periodsPerYear: 52,
  income: "0",
  nonPeriodic: "1910",
  pensionable: "1910",
  pensionableNonPeriodic: "1910",
};

// CRA CPP calculation guide, bonus/retroactive/irregular payments:
// separate payments receive no basic exemption; the annual limits still apply.
test("separate CPP bonus prices its full pensionable amount without a period exemption", () => {
  const result = calculateT4127(assessedCanadianWages(payment));
  assert.equal(result.cpp, "113.6500");
  assert.equal(result.cppEmployer, "113.6500");
  assert.equal(result.cpp2, "0.0000");
  assert.equal(result.factors.CPP_EXEMPTION, "0.0000");
  assert.equal(result.factors.C, "113.6500");
});

test("regular plus bonus in one payment retains the regular period exemption", () => {
  const result = calculateT4127(
    assessedCanadianWages({ ...payment, income: "1000", pensionable: "2910" }),
  );
  assert.equal(result.cpp, "169.1400");
  assert.equal(result.factors.CPP_EXEMPTION, "67.3000");
});

test("tax-only regular-income reference cannot grant a CPP exemption to a separate payment", () => {
  const result = calculateT4127(
    assessedCanadianWages({ ...payment, income: "1532.01", separateNonPeriodicPayment: true }),
  );
  assert.equal(result.cpp, "113.6500");
  assert.equal(result.factors.CPP_EXEMPTION, "0.0000");
  assert.equal(result.factors.C, "113.6500");
});

test("separate CPP payment keeps annual CPP and CPP2 remaining-room limits", () => {
  const result = calculateT4127(
    assessedCanadianWages({
      ...payment,
      ytd: { cpp: "4230.40", cpp2: "415.95", pensionable: "85000" },
    }),
  );
  assert.equal(result.cpp, "0.0500");
  assert.equal(result.cpp2, "0.0500");
  assert.equal(result.cppEmployer, "0.1000");
});

test("separate CPP payment retains contribution-month proration and exemptions", () => {
  const limited = calculateT4127(
    assessedCanadianWages({
      ...payment,
      cppMonths: 6,
      ytd: { cpp: "2115.20", cpp2: "207.97", pensionable: "50000" },
    }),
  );
  assert.equal(limited.cpp, "0.0300");
  assert.equal(limited.cpp2, "0.0300");
  const exempt = calculateT4127(assessedCanadianWages({ ...payment, cppExempt: true }));
  assert.equal(exempt.cpp, "0.0000");
  assert.equal(exempt.cpp2, "0.0000");
});

test("non-taxable separate pensionable remuneration uses its contribution base", () => {
  const result = calculateT4127(
    assessedCanadianWages({
      ...payment,
      nonPeriodic: "0",
      pensionable: "500",
      pensionableNonPeriodic: "500",
    }),
  );
  assert.equal(result.cpp, "29.7500");
  assert.equal(result.factors.CPP_EXEMPTION, "0.0000");
});

test("CPP separate-payment treatment leaves QPP exemption and contribution behavior unchanged", () => {
  const baseline = calculateT4127(assessedCanadianWages({ ...payment, province: "QC" }));
  const explicit = calculateT4127(
    assessedCanadianWages({ ...payment, province: "QC", separateNonPeriodicPayment: true }),
  );
  // Published 2026 QPP total rate 0.0630; the unchanged weekly exemption is 67.30.
  assert.equal(explicit.cpp, "116.0900");
  assert.deepEqual(explicit, baseline);
});
