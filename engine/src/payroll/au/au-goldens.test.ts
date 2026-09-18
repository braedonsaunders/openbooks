/**
 * AU 2026–27 parity proofs: agency goldens, hand-worked cases, sweep.
 *
 * Provenance: no ATO worked example is quotable from this vantage
 * (ato.gov.au 403s), so per the live-shard bar these goldens are built FROM
 * THE TABLES with the arithmetic shown in comments — each expected figure is
 * derived by hand from the Schedule 7 / MLA / HESA figures quoted in
 * ./tax-year-2027.ts, and the engine must reproduce it to the cent. The
 * independence is real: the comments below do the multiplication the engine
 * is not allowed to get wrong.
 *
 * Amounts are decimal strings at fixed scale ("810.0000"), never floats.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateAu2027, computeAuStatutory } from "./compute-statutory.ts";

const RESIDENT = {
  residency: "australian_resident",
  workingHolidayMaker: false,
  claimsThreshold: true,
  tfnQuoted: true,
  stslDebt: false,
  periodsPerYear: 12,
} as const;

// $60,000 resident, threshold claimed, monthly.
// Tax: (45,000−18,200)×15% = 4,020.00; (60,000−45,000)×30% = 4,500.00 → 8,520.00.
// Medicare: 60,000 > 35,013 → 2% = 1,200.00. HELP: none.
// PAYG: 9,720.00 / 12 = 810.00. SG: 5,000 × 12% = 600.00.
test("AU golden: $60k resident monthly withholds 810.00 + 600.00 SG", () => {
  const result = calculateAu2027({
    ...RESIDENT, annualIncome: "60000", pensionable: "5000",
  });
  assert.equal(result.payg, "810.0000");
  assert.equal(result.sg, "600.0000");
});

// $32,000 resident with STSL, fortnightly. Medicare shades, so HELP is nil.
// Tax: (32,000−18,200)×15% = 2,070.00.
// Medicare: min(2%×32,000 = 640.00, 10%×(32,000−28,011) = 398.90) = 398.90.
// Reduced levy → s154-1(2) zeroes HELP. PAYG: 2,468.90 / 26 = 94.9576… → 94.96.
// SG: 1,230.77 × 12% = 147.6924 → 147.69.
test("AU golden: $32k STSL fortnightly shades Medicare and nils HELP", () => {
  const result = calculateAu2027({
    ...RESIDENT, annualIncome: "32000", stslDebt: true,
    pensionable: "1230.77", periodsPerYear: 26,
  });
  assert.equal(result.payg, "94.9600");
  assert.equal(result.sg, "147.6900");
});

// $100,000 foreign resident, monthly. No threshold, no Medicare, no HELP.
// Tax: 100,000 × 30% = 30,000.00 → PAYG 2,500.00.
// SG: 8,333.33 × 12% = 999.9996 → half-up to 1,000.00.
test("AU golden: $100k foreign resident withholds 2,500.00 flat", () => {
  const result = calculateAu2027({
    ...RESIDENT,
    residency: "foreign_resident",
    annualIncome: "100000",
    pensionable: "8333.33",
  });
  assert.equal(result.payg, "2500.0000");
  assert.equal(result.sg, "1000.0000");
});

// $60,000 resident WITHOUT a threshold claim (scale-1 effect, engine-stated).
// Tax: 45,000×15% = 6,750.00; 15,000×30% = 4,500.00 → 11,250.00.
// Medicare 1,200.00 → PAYG 12,450.00 / 12 = 1,037.50.
test("AU golden: $60k without threshold claim withholds from the first dollar", () => {
  const result = calculateAu2027({
    ...RESIDENT, annualIncome: "60000", claimsThreshold: false, pensionable: "5000",
  });
  assert.equal(result.payg, "1037.5000");
  assert.equal(result.sg, "600.0000");
});

// $50,000 working holiday maker, monthly. Part III bands, no Medicare.
// Tax: 45,000×15% = 6,750.00; 5,000×30% = 1,500.00 → 8,250.00 → PAYG 687.50.
test("AU golden: $50k WHM uses Part III bands with no Medicare", () => {
  const result = calculateAu2027({
    ...RESIDENT, annualIncome: "50000", workingHolidayMaker: true, pensionable: "4166.67",
  });
  assert.equal(result.payg, "687.5000");
  assert.equal(result.sg, "500.0000");
});

// $150,000 resident with STSL, monthly. Both HELP bands + 10% cap slack.
// Tax: 4,020.00 + 90,000×30% (27,000.00) + 15,000×37% (5,550.00) = 36,570.00.
// Medicare: 3,000.00 (full → HELP applies).
// HELP: (129,717−69,528)×15% = 9,028.35; (150,000−129,717)×17% = 3,448.11 →
// 12,476.46 ≤ 10%×150,000 cap. PAYG: 52,046.46/12 = 4,337.205 → 4,337.21.
test("AU golden: $150k STSL hits both HELP bands under the 10% cap", () => {
  const result = calculateAu2027({
    ...RESIDENT, annualIncome: "150000", stslDebt: true, pensionable: "12500",
  });
  assert.equal(result.payg, "4337.2100");
  assert.equal(result.sg, "1500.0000");
});

// Band-boundary sweep, periodsPerYear 1 so PAYG equals the annual figure.
// Resident low edges (Medicare nil below $28,011; full 2% above $35,013):
// 18,200 → 0; 18,201 → 0.15;
// 45,000 → 4,020.00 tax + 900.00 Medicare = 4,920.00;
// 45,001 → 4,020.30 + 900.02 = 4,920.32.
test("AU sweep: resident low band edges at, below and above", () => {
  const cases: Array<[string, string]> = [
    ["18200", "0.0000"],
    ["18201", "0.1500"],
    ["45000", "4920.0000"],
    ["45001", "4920.3200"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, annualIncome: income, pensionable: "0", periodsPerYear: 1,
    });
    assert.equal(result.payg, expected, `income ${income}`);
  }
});

// Foreign-resident high edges (no Medicare/HELP for foreign residents):
// 135,000 → 135,000×30% = 40,500.00; 135,001 → +0.37;
// 190,000 → 40,500.00 + 55,000×37% = 60,850.00; 190,001 → +0.45.
test("AU sweep: foreign-resident high band edges at, below and above", () => {
  const cases: Array<[string, string]> = [
    ["135000", "40500.0000"],
    ["135001", "40500.3700"],
    ["190000", "60850.0000"],
    ["190001", "60850.4500"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT,
      residency: "foreign_resident",
      annualIncome: income,
      pensionable: "0",
      periodsPerYear: 1,
    });
    assert.equal(result.payg, expected, `income ${income}`);
  }
});

// Medicare edges (resident, no STSL, periods 1): threshold, shade, full.
test("AU sweep: Medicare threshold and phase-in edges", () => {
  const cases: Array<[string, string]> = [
    // 28,011: no levy. Tax (28,011−18,200)×15% = 1,471.65.
    ["28011", "1471.6500"],
    // 28,012: min(560.24, 0.10) = 0.10 levy. Tax 1,471.80.
    ["28012", "1471.9000"],
    // 35,013: min(700.26, 700.20) = 700.20 levy. Tax 2,521.95.
    ["35013", "3222.1500"],
    // 35,014: full 700.28 levy. Tax 2,522.10.
    ["35014", "3222.3800"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, annualIncome: income, pensionable: "0", periodsPerYear: 1,
    });
    assert.equal(result.payg, expected, `income ${income}`);
  }
});

// HELP edges (resident + STSL, periods 1): minimum income and second band.
// 69,528: tax 11,378.40 + Medicare 1,390.56, HELP nil → 12,768.96.
// 69,529: tax 11,378.70 + Medicare 1,390.58 + 0.15 HELP → 12,769.43.
// 129,717: tax 29,435.10 + Medicare 2,594.34 + 9,028.35 HELP → 41,057.79.
// 129,718: tax 29,435.40 + Medicare 2,594.36 + 9,028.52 HELP → 41,058.28.
test("AU sweep: HELP minimum-income and second-band edges", () => {
  const cases: Array<[string, string]> = [
    ["69528", "12768.9600"],
    ["69529", "12769.4300"],
    ["129717", "41057.7900"],
    ["129718", "41058.2800"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, annualIncome: income, stslDebt: true, pensionable: "0", periodsPerYear: 1,
    });
    assert.equal(result.payg, expected, `income ${income}`);
  }
});

test("AU engine refuses no-TFN and bad periods by name", () => {
  assert.throws(
    () => calculateAu2027({ ...RESIDENT, annualIncome: "60000", pensionable: "0", tfnQuoted: false }),
    /no quoted TFN/,
  );
  assert.throws(
    () => calculateAu2027({ ...RESIDENT, annualIncome: "60000", pensionable: "0", periodsPerYear: 0 }),
    /periodsPerYear/,
  );
});

function stubCtx(overrides: Record<string, unknown> = {}): Parameters<typeof computeAuStatutory>[0] {
  const pushed: Array<{ key: string; amount: string; sequence: number }> = [];
  return {
    taxYear: 2027,
    income: "5000",
    pensionable: "5000",
    periodsPerYear: 12,
    certificateFor: () => ({
      certificate: {},
      onFile: true,
      effectiveFrom: null,
      answers: {
        tax_file_number: "123456782",
        residency: "australian_resident",
        working_holiday_maker: "false",
        tax_free_threshold: "true",
        stsl_debt: "false",
      },
      missing: [],
    }),
    bool: (value: string | null | undefined) => value === "true",
    pushStatutory: (
      systemKey: string,
      _kind: "deduction" | "employer_contribution",
      _description: string,
      amount: string,
      sequence: number,
    ) => {
      pushed.push({ key: systemKey, amount, sequence });
      (stubCtx as { lastPushed?: unknown }).lastPushed = pushed;
    },
    ...overrides,
  } as unknown as Parameters<typeof computeAuStatutory>[0];
}

test("AU computeStatutory pushes PAYG deduction and SG employer accrual", async () => {
  await computeAuStatutory(stubCtx());
  const pushed = (stubCtx as { lastPushed?: Array<{ key: string; amount: string; sequence: number }> }).lastPushed ?? [];
  assert.deepEqual(pushed, [
    { key: "payg_withholding", amount: "810.0000", sequence: 110 },
    { key: "super_guarantee", amount: "600.0000", sequence: 210 },
  ]);
});

test("AU computeStatutory refuses untranscribed tax years by name", async () => {
  await assert.rejects(
    () => computeAuStatutory(stubCtx({ taxYear: 2026 })),
    /tax year 2026 has not been transcribed/,
  );
  await assert.rejects(
    () => computeAuStatutory(stubCtx({ taxYear: 2028 })),
    /tax year 2028 has not been transcribed/,
  );
});
