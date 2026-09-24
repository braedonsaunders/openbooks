/**
 * Pub 15-T conformance tests.
 *
 * External goldens: the printed 2026 Annual Percentage Method schedules
 * (irs.gov/publications/p15t) — every row's tentative amount is re-derived
 * from the cumulative bracket sums, so any transcription drift in rates.ts
 * fails loudly — plus the SSA 2026 wage base and the FUTA statutory
 * constants. The full-stub cases are hand-worked through Worksheet 1A line
 * by line (round at each line), independent of the engine code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculatePub15T } from "./pub15t.ts";
import { NO_WITHHOLDING_STATES, RATES_2026, ratesForPayDate, US_STATES } from "./rates.ts";

function calculateWithConfiguredFuta(input: Parameters<typeof calculatePub15T>[0]) {
  // These cases cover other Pub 15-T behavior; state/year rate selection has
  // its own source-backed tests below. Set an explicit standard-rate override.
  return calculatePub15T({ futaEffectiveRate: "0.006", ...input });
}

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

test("edition resolution: 2026, 2025 and 2024, refuses unknown years", () => {
  assert.equal(ratesForPayDate("2026-01-01").year, 2026);
  assert.equal(ratesForPayDate("2026-12-31").year, 2026);
  assert.equal(ratesForPayDate("2025-01-01").year, 2025);
  assert.equal(ratesForPayDate("2025-12-31").year, 2025);
  assert.equal(ratesForPayDate("2024-01-01").year, 2024);
  assert.equal(ratesForPayDate("2024-12-31").year, 2024);
  assert.throws(() => ratesForPayDate("2023-12-31"));
  assert.throws(() => ratesForPayDate("2027-01-01"));
});

test("printed schedules are internally consistent (cumulative bracket sums)", () => {
  // tentative[i+1] must equal tentative[i] + rate[i] × (atLeast[i+1] − atLeast[i]).
  // The single-filer checkbox schedule prints two thresholds rounded from
  // half-dollar boundaries (108,937.50 → 108,938; 136,162.50 → 136,163), so
  // its recomputation may differ by rate × $0.50 — everywhere else is exact.
  for (const [kind, tables] of [["standard", RATES_2026.standard], ["checkbox", RATES_2026.checkbox]] as const) {
    for (const [status, schedule] of Object.entries(tables)) {
      for (let i = 0; i + 1 < schedule.length; i++) {
        const expected = Number(schedule[i]!.tentative)
          + Number(schedule[i]!.rate) * (Number(schedule[i + 1]!.atLeast) - Number(schedule[i]!.atLeast));
        const printed = Number(schedule[i + 1]!.tentative);
        const tolerance = kind === "checkbox" && status === "single" ? 0.2 : 0.005;
        assert.ok(
          Math.abs(printed - expected) <= tolerance,
          `${kind}/${status} row ${i + 1}: printed ${printed}, cumulative ${expected}`,
        );
      }
    }
  }
});

test("standard schedules match the Rev. Proc. 2025-32 brackets shifted by the W-4 adjustment", () => {
  // STANDARD table start = standard deduction − Worksheet 1A adjustment.
  // 2026: single 16,100 − 8,600 = 7,500; MFJ 32,200 − 12,900 = 19,300;
  // HoH 24,150 − 8,600 = 15,550.
  assert.equal(RATES_2026.standard.single[1]!.atLeast, "7500");
  assert.equal(RATES_2026.standard.married_joint[1]!.atLeast, "19300");
  assert.equal(RATES_2026.standard.head_household[1]!.atLeast, "15550");
  // Checkbox table start = standard deduction ÷ 2.
  assert.equal(RATES_2026.checkbox.single[1]!.atLeast, "8050");
  assert.equal(RATES_2026.checkbox.married_joint[1]!.atLeast, "16100");
  assert.equal(RATES_2026.checkbox.head_household[1]!.atLeast, "12075");
});

test("FICA/FUTA statutory constants (SSA 2026 announcement, IRC §3301)", () => {
  assert.equal(RATES_2026.fica.ssWageBase, "184500");
  assert.equal(RATES_2026.fica.ssRate, "0.062");
  assert.equal(RATES_2026.fica.medicareRate, "0.0145");
  assert.equal(RATES_2026.futa.wageBase, "7000");
  assert.equal(RATES_2026.futa.fullCreditEffectiveRate, "0.006");
});

test("single, biweekly $2,000, default W-4 — full hand-worked stub", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-02-13", periodsPerYear: 26, wages: "2000.00", filingStatus: "single",
  });
  // 1b = 52,000; 1i = 52,000 − 8,600 = 43,400
  assert.equal(result.factors.AAWA, money("43400"));
  // 2g = 1,240 + 12% × (43,400 − 19,900) = 4,060; 2h = 4,060 ÷ 26 = 156.15
  assert.equal(result.factors.TW, money("4060"));
  assert.equal(result.fit, money("156.15"));
  assert.equal(result.ss, money("124.00")); // 2,000 × 6.2%
  assert.equal(result.medicare, money("29.00")); // 2,000 × 1.45%
  assert.equal(result.additionalMedicare, money("0"));
  assert.equal(result.futa, money("12.00")); // 2,000 × 0.6%
  assert.equal(result.suta, money("0"));
});

test("married filing jointly, semi-monthly $4,000, Step 3 credits $4,400", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "4000.00",
    filingStatus: "married_joint", dependentCredits: "4400.00",
  });
  // 1i = 96,000 − 12,900 = 83,100; 2g = 2,480 + 12% × 39,000 = 7,160
  // 2h = 7,160 ÷ 24 = 298.33; 3b = 4,400 ÷ 24 = 183.33; 3c = 115.00
  assert.equal(result.factors.AAWA, money("83100"));
  assert.equal(result.fit, money("115.00"));
});

test("single with the Step 2 checkbox, weekly $1,500 — checkbox schedule", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-01-09", periodsPerYear: 52, wages: "1500.00",
    filingStatus: "single", multipleJobs: true,
  });
  // 1i = 78,000 (no adjustment when the box is checked)
  // 2g = 8,983 + 24% × (78,000 − 60,900) = 13,087; ÷ 52 = 251.67
  assert.equal(result.factors.AAWA, money("78000"));
  assert.equal(result.fit, money("251.67"));
});

test("head of household, biweekly $3,000, 4(a) 10,000 / 4(b) 5,000 / 4(c) 50", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-05-08", periodsPerYear: 26, wages: "3000.00",
    filingStatus: "head_household",
    otherIncomeAnnual: "10000.00", deductionsAnnual: "5000.00", extraPerPeriod: "50.00",
  });
  // 1i = 78,000 + 10,000 − 5,000 − 8,600 = 74,400
  // 2g = 1,770 + 12% × 41,150 = 6,708; ÷ 26 = 258.00; + 50 = 308.00
  assert.equal(result.factors.AAWA, money("74400"));
  assert.equal(result.fit, money("308.00"));
});

test("2019-or-earlier W-4: married, 3 allowances, monthly $5,000", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-06-30", periodsPerYear: 12, wages: "5000.00",
    filingStatus: "single", // ignored — pre-2020 marital status wins
    pre2020: { allowances: 3, married: true },
  });
  // 1l = 60,000 − 3 × 4,300 = 47,100 (STANDARD MFJ schedule)
  // 2g = 2,480 + 12% × 3,000 = 2,840; ÷ 12 = 236.67
  assert.equal(result.factors.AAWA, money("47100"));
  assert.equal(result.fit, money("236.67"));
});

test("Social Security wage-base crossing and Additional Medicare trigger", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
    ytd: { ssWages: "183000.00", medicareWages: "199000.00" },
  });
  // SS taxable = min(3,000, 184,500 − 183,000) = 1,500 → 93.00
  assert.equal(result.ss, money("93.00"));
  assert.equal(result.ssEmployer, money("93.00"));
  // Medicare is uncapped: 3,000 × 1.45% = 43.50
  assert.equal(result.medicare, money("43.50"));
  // Additional Medicare on the slice over 200,000: 2,000 × 0.9% = 18.00
  assert.equal(result.additionalMedicare, money("18.00"));
});

test("FUTA cap and configured SUI", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-04-15", periodsPerYear: 26, wages: "1000.00", filingStatus: "single",
    sui: { rate: "0.027", wageBase: "9000" },
    ytd: { futaWages: "6500.00", suiWages: "8500.00" },
  });
  // FUTA taxable = min(1,000, 7,000 − 6,500) = 500 → 3.00 at 0.6%
  assert.equal(result.futa, money("3.00"));
  // SUI taxable = min(1,000, 9,000 − 8,500) = 500 → 13.50 at 2.7%
  assert.equal(result.suta, money("13.50"));
});

test("credit-reduction state: configurable effective FUTA rate", () => {
  const result = calculateWithConfiguredFuta({
    payDate: "2026-04-15", periodsPerYear: 26, wages: "1000.00", filingStatus: "single",
    futaEffectiveRate: "0.012",
  });
  assert.equal(result.futa, money("12.00"));
});

test("FUTA uses the effective 2025 Schedule A rate for California without an override", () => {
  // IRS 2025 Schedule A (Form 940) lists California's 1.2% credit reduction;
  // add it to the ordinary 0.6% net rate: $7,000 × 1.8% = $126.
  // https://www.irs.gov/pub/irs-prior/f940sa--2025.pdf
  for (const state of US_STATES) {
    const result = calculatePub15T({
      payDate: "2025-12-31", periodsPerYear: 26, wages: "7000.00",
      filingStatus: "single", futaRegion: state,
    });
    assert.equal(result.futa, money(state === "CA" ? "126.00" : "42.00"), state);
  }
});

test("FUTA Schedule A resolution keeps the 2024 reductions effective for their own year", () => {
  // IRS 2024 Schedule A lists CA and NY at 0.9%; 0.6% + 0.9% = 1.5%.
  // https://www.irs.gov/pub/irs-prior/f940sa--2024.pdf
  for (const state of US_STATES) {
    const result = calculatePub15T({
      payDate: "2024-12-31", periodsPerYear: 26, wages: "7000.00",
      filingStatus: "single", futaRegion: state,
    });
    assert.equal(result.futa, money(state === "CA" || state === "NY" ? "105.00" : "42.00"), state);
  }
});

test("FUTA refuses a year without a transcribed Schedule A instead of using 0.6%", () => {
  assert.throws(
    () => calculatePub15T({
      payDate: "2026-12-31", periodsPerYear: 26, wages: "7000.00",
      filingStatus: "single", futaRegion: "CA",
    }),
    /FUTA credit-reduction rates for 2026 are not transcribed from Form 940 Schedule A.*refused by name/,
  );
});

test("supplemental wages: 22% flat rate, 37% past $1,000,000 YTD", () => {
  const flat = calculateWithConfiguredFuta({
    payDate: "2026-12-15", periodsPerYear: 26, wages: "2000.00",
    supplemental: "5000.00", filingStatus: "single",
  });
  // Periodic FIT unchanged (156.15) + 5,000 × 22% = 1,100
  assert.equal(flat.fitSupplemental, money("1100.00"));
  assert.equal(flat.fit, money("1256.15"));
  // FICA/FUTA bases include the supplemental payment by default.
  assert.equal(flat.ss, money("434.00")); // 7,000 × 6.2%
  assert.equal(flat.futa, money("42.00")); // 7,000 × 0.6%

  const high = calculateWithConfiguredFuta({
    payDate: "2026-12-15", periodsPerYear: 26, wages: "0.00",
    supplemental: "10000.00", filingStatus: "single",
    ytd: { supplemental: "998000.00" },
  });
  // 2,000 at 22% (440) + 8,000 at 37% (2,960) = 3,400
  assert.equal(high.fitSupplemental, money("3400.00"));
});

test("exemptions: FIT-exempt keeps FICA; FICA-exempt keeps FIT; FUTA-exempt", () => {
  const fitExempt = calculateWithConfiguredFuta({
    payDate: "2026-02-13", periodsPerYear: 26, wages: "2000.00",
    filingStatus: "single", fitExempt: true, extraPerPeriod: "25.00",
  });
  assert.equal(fitExempt.fit, money("0"));
  assert.equal(fitExempt.ss, money("124.00"));
  assert.equal(fitExempt.medicare, money("29.00"));

  const ficaExempt = calculateWithConfiguredFuta({
    payDate: "2026-02-13", periodsPerYear: 26, wages: "2000.00",
    filingStatus: "single", ficaExempt: true,
  });
  assert.equal(ficaExempt.fit, money("156.15"));
  assert.equal(ficaExempt.ss, money("0"));
  assert.equal(ficaExempt.medicare, money("0"));
  assert.equal(ficaExempt.additionalMedicare, money("0"));

  const futaExempt = calculateWithConfiguredFuta({
    payDate: "2026-02-13", periodsPerYear: 26, wages: "2000.00",
    filingStatus: "single", futaExempt: true, sui: { rate: "0.027", wageBase: "9000" },
  });
  assert.equal(futaExempt.futa, money("0"));
  assert.equal(futaExempt.suta, money("0"));
});

test("Additional Medicare when YTD wages already exceed $200,000", () => {
  // The over-threshold slice is incremental: with $201,000 already in, only
  // the $3,000 of this period that pushes further past the threshold is
  // taxed — max0(204,000 − 200,000) − max0(201,000 − 200,000) = 3,000, so
  // 3,000 × 0.9% = 27.00. Adding the already-taxed slice instead of
  // subtracting it withholds $45.00 on this cheque, every cheque, all year.
  const result = calculateWithConfiguredFuta({
    payDate: "2026-11-15", periodsPerYear: 24, wages: "3000.00", filingStatus: "single",
    ytd: { medicareWages: "201000.00" },
  });
  assert.equal(result.medicare, money("43.50")); // 3,000 × 1.45%, uncapped
  assert.equal(result.additionalMedicare, money("27.00"));
});

test("period-frequency boundaries: annual pay and P=2000 calculate, 0 and 2001 refuse", () => {
  // Annual payroll exercises the schedule with no annualization in the way;
  // P = 2000 is the highest documented frequency (daily + leap adjustments).
  const annual = calculateWithConfiguredFuta({
    payDate: "2026-06-15", periodsPerYear: 1, wages: "60000.00", filingStatus: "single",
  });
  // 1i = 60,000 − 8,600 = 51,400; 2g = 1,240 + 12% × 31,500 = 5,020
  assert.equal(annual.factors.AAWA, money("51400"));
  assert.equal(annual.fit, money("5020.00"));

  const frequent = calculateWithConfiguredFuta({
    payDate: "2026-06-15", periodsPerYear: 2000, wages: "30.00", filingStatus: "single",
  });
  // Same annualized figures, de-annualized: 5,020 ÷ 2,000 = 2.51.
  assert.equal(frequent.fit, money("2.51"));

  assert.throws(() => calculateWithConfiguredFuta({
    payDate: "2026-06-15", periodsPerYear: 0, wages: "30.00", filingStatus: "single",
  }), /invalid pay periods per year/);
  assert.throws(() => calculateWithConfiguredFuta({
    payDate: "2026-06-15", periodsPerYear: 2001, wages: "30.00", filingStatus: "single",
  }), /invalid pay periods per year/);
});

test("2019-or-earlier W-4 with zero allowances withholds from dollar one", () => {
  // Zero allowances is valid (no $4,300 subtractions) — refusing it blocks
  // every legacy W-4 that claims no allowances.
  const result = calculateWithConfiguredFuta({
    payDate: "2026-06-30", periodsPerYear: 12, wages: "5000.00",
    filingStatus: "single",
    pre2020: { allowances: 0, married: false },
  });
  // 1l = 60,000 − 0 = 60,000; 2g = 5,800 + 22% × 2,100 = 6,262; ÷ 12 = 521.83
  assert.equal(result.factors.AAWA, money("60000"));
  assert.equal(result.fit, money("521.83"));
});

test("Worksheet 1A and statutory constants are the published figures", () => {
  // Digit-exact pins: any transcription slip in these Pub 15-T / SSA / IRC
  // figures fails here, independently of the behavioral goldens above.
  assert.equal(RATES_2026.wageAdjustment.marriedJoint, "12900"); // line 1g
  assert.equal(RATES_2026.wageAdjustment.other, "8600"); // line 1g
  assert.equal(RATES_2026.allowanceAmount, "4300"); // line 1k
  assert.equal(RATES_2026.supplemental.flatRate, "0.22"); // Pub 15 §7
  assert.equal(RATES_2026.supplemental.mandatoryHighRate, "0.37");
  assert.equal(RATES_2026.supplemental.mandatoryThreshold, "1000000");
  assert.equal(RATES_2026.fica.additionalMedicareRate, "0.009");
  assert.equal(RATES_2026.fica.additionalMedicareThreshold, "200000");
  assert.equal(RATES_2026.futa.grossRate, "0.06"); // IRC §3301
});

test("wave-1 state coverage list is exactly the nine no-withholding states", () => {
  assert.deepEqual(
    [...NO_WITHHOLDING_STATES].sort(),
    ["AK", "FL", "NH", "NV", "SD", "TN", "TX", "WA", "WY"],
  );
  for (const state of NO_WITHHOLDING_STATES) {
    assert.ok((US_STATES as readonly string[]).includes(state));
  }
  assert.equal(US_STATES.length, 51); // 50 states + DC
});
