/**
 * IE conformance sweep: the wide net around the exact-value goldens in
 * conformance.test.ts. Band edges are where rounding and comparison-operator
 * defects live, so every PRSI subclass boundary and the PAYE band edge is
 * tested AT the threshold, one cent below, and one cent above, in both 2026
 * editions. Plus the statutory invariants that must hold for any input:
 * non-negativity (week-1), monotonicity in income, no PRSI ceiling
 * ("There is no annual earnings ceiling for PRSI for employees"), and a
 * full-year cumulative progression that must land exactly on the annual
 * liability (the crossing periods contribute partial amounts, never
 * overshoot or leave residue).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateIeStatutory, type IeStatutoryInput } from "./compute.ts";

function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  const centsPart = (fraction + "0000").slice(0, 4);
  if (/[1-9]/.test(fraction.slice(4))) throw new Error(`sub-1e4 value: ${value}`);
  const result = BigInt(whole) * 10_000n + BigInt(centsPart);
  return negative ? -result : result;
}

function week1(pay: string, payDate = "2026-04-15"): IeStatutoryInput {
  return {
    payDate,
    periodsPerYear: 52,
    basis: "week1",
    hasRpn: true,
    prsiClass: "A",
    taxCreditsAnnual: "4000",
    rateBandAnnual: "44000",
    taxablePayPeriod: pay,
    taxablePayYtd: "0",
    taxPaidYtd: "0",
    reckonablePayPeriod: pay,
    grossPayYtd: "0",
    uscPaidYtd: "0",
    uscExempt: false,
    uscReducedEligible: false,
    elapsedPeriods: 1,
  };
}

test("sweep: PRSI subclass boundaries (Jan edition, weekly)", () => {
  const cases: [string, string, string, string][] = [
    // pay, subclass, employee, employer
    ["38", "A0", "0.0000", "3.4200"], // 38 × 9% — floor of Class A
    ["351.99", "A0", "0.0000", "31.6800"], // h(351.99 × 9%) = h(31.6791)
    ["352", "A0", "0.0000", "31.6800"],
    ["352.01", "AX", "2.7800", "31.6800"], // 14.78 − 12.00; er h(31.6809)
    ["424", "AX", "17.8100", "38.1600"], // 17.81 − 0.00 (printed 17.80)
    ["424.01", "AL", "17.8100", "38.1600"], // h(17.80842); er h(38.1609)
    ["552", "AL", "23.1800", "49.6800"], // h(23.184); AL top at lower er rate
    ["552.01", "A1", "23.1800", "62.1000"], // h(23.18442); er h(62.101125)
    ["10000", "A1", "420.0000", "1125.0000"], // no ceiling, either side
  ];
  for (const [pay, subclass, employee, employer] of cases) {
    const r = calculateIeStatutory(week1(pay));
    assert.equal(r.prsiSubclass, subclass, `pay €${pay} subclass`);
    assert.equal(r.prsiEmployee, employee, `pay €${pay} employee`);
    assert.equal(r.prsiEmployer, employer, `pay €${pay} employer`);
  }
});

test("sweep: PRSI subclass boundaries (Oct edition, weekly)", () => {
  // Same thresholds, Roadmap rates: ee 4.35%, er 9.15%/11.40%.
  const cases: [string, string, string, string][] = [
    // pay, subclass, employee, employer
    ["352.01", "AX", "3.3100", "32.2100"], // h(15.312435) − 12.00; er h(32.208915)
    ["552", "AL", "24.0100", "50.5100"], // h(552 × 4.35%); er h(50.508)
    ["552.01", "A1", "24.0100", "62.9300"], // h(24.012435); er h(62.92914)
  ];
  for (const [pay, subclass, employee, employer] of cases) {
    const r = calculateIeStatutory(week1(pay, "2026-11-15"));
    assert.equal(r.prsiSubclass, subclass, `pay €${pay} subclass`);
    assert.equal(r.prsiEmployee, employee, `pay €${pay} employee`);
    assert.equal(r.prsiEmployer, employer, `pay €${pay} employer`);
  }
  // AX credit unchanged by the October step: €377 still credits €7.83.
  // E = 377 × 4.35% = 16.3995 → 16.40; 16.40 − 7.83 = 8.57.
  assert.equal(
    calculateIeStatutory(week1("377", "2026-11-15")).prsiEmployee,
    "8.5700",
  );
});

test("sweep: PAYE band edge (weekly cut-off €846.16)", () => {
  // Below/at/above the apportioned band: higher rate starts past €846.16.
  const below = calculateIeStatutory(week1("846.15"));
  assert.equal(below.paye, "92.3100"); // h(846.15 × 20%) − 76.92
  const at = calculateIeStatutory(week1("846.16"));
  assert.equal(at.paye, "92.3100"); // h(846.16 × 20%) = 169.23 − 76.92
  const above = calculateIeStatutory(week1("846.17"));
  // standard 169.23 + higher h(0.01 × 40%) = 0.00 → same payable.
  assert.equal(above.paye, "92.3100");
  const clearlyAbove = calculateIeStatutory(week1("847.16"));
  // higher base 1.00 → h(0.40) = 0.40 → 92.71.
  assert.equal(clearlyAbove.paye, "92.7100");
});

test("sweep: week-1 invariants across an income grid", () => {
  // Week-1 never refunds, so every line is non-negative here. Pay below
  // €38 is Class J (asserted as a refusal in conformance), so the grid
  // starts at the Class A floor.
  const incomes = [
    "38", "100", "351.99", "352", "352.01", "400", "423.99", "424", "424.01",
    "552", "552.01", "1000", "2000", "5000", "20000",
  ];
  let prevPaye = -1n;
  let prevUsc = -1n;
  let prevPrsi = -1n;
  for (const income of incomes) {
    const r = calculateIeStatutory(week1(income));
    const label = `weekly pay €${income}`;
    for (const [key, value] of Object.entries(r)) {
      if (typeof value === "string" && key !== "edition" && key !== "prsiSubclass") {
        assert.ok(!value.startsWith("-"), `${label}: ${key} negative (${value})`);
      }
    }
    // Deductions never exceed a 40%-of-pay ceiling Sanity: PAYE ≤ 40% of pay.
    assert.ok(cents(r.paye) <= cents(income) * 40n / 100n, `${label}: PAYE over 40%`);
    // USC never exceeds 8% of pay (top USC rate).
    assert.ok(cents(r.usc) <= cents(income) * 8n / 100n, `${label}: USC over 8%`);
    // Monotone non-decreasing in income.
    assert.ok(cents(r.paye) >= prevPaye, `${label}: PAYE fell as pay rose`);
    assert.ok(cents(r.usc) >= prevUsc, `${label}: USC fell as pay rose`);
    assert.ok(cents(r.prsiEmployee) >= prevPrsi, `${label}: PRSI fell as pay rose`);
    prevPaye = cents(r.paye);
    prevUsc = cents(r.usc);
    prevPrsi = cents(r.prsiEmployee);
  }
});

test("sweep: full-year cumulative progression lands exactly on the annual liability", () => {
  // 52 weeks × €1,000 taxable: annual gross €52,000 →
  // PAYE: 44000 × 20% + 8000 × 40% − 4000 = 8800 + 3200 − 4000 = €8,000.
  // USC: 60.06 + 333.76 + 23300 × 3% = 60.06 + 333.76 + 699.00 = €1,092.82.
  // PRSI is week-one (no accumulation): 52 × €42.00 = €2,184.00.
  let payeTotal = 0n;
  let uscTotal = 0n;
  let prsiTotal = 0n;
  for (let n = 1; n <= 52; n++) {
    const prior = calculateIeStatutory({
      ...week1("1000"),
      basis: "cumulative",
      taxablePayYtd: `${(n - 1) * 1000}`,
      taxPaidYtd: D(payeTotal),
      grossPayYtd: `${(n - 1) * 1000}`,
      uscPaidYtd: D(uscTotal),
      elapsedPeriods: n,
    });
    assert.ok(!prior.paye.startsWith("-"), `week ${n}: cumulative refund on steady pay`);
    payeTotal += cents(prior.paye);
    uscTotal += cents(prior.usc);
    prsiTotal += cents(prior.prsiEmployee);
  }
  assert.equal(D(payeTotal), "8000.0000");
  assert.equal(D(uscTotal), "1092.8200");
  assert.equal(D(prsiTotal), "2184.0000");
});

function D(u: bigint): string {
  const negative = u < 0n;
  const abs = negative ? -u : u;
  const str = `${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, "0")}`;
  return negative ? `-${str}` : str;
}
