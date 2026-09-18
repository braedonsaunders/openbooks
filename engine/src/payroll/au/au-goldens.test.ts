/**
 * AU 2026–27 parity proofs for the instrument's per-period method.
 *
 * Mechanism 2 (hand-worked, arithmetic shown in comments — each expected
 * figure is derived by hand from the Schedule 1 / Schedule 8 coefficients
 * quoted in ./schedule1-2027.ts, and the engine must reproduce it to the
 * dollar). Mechanism 1 (the instrument's own sample data and worked
 * examples) lives in au-instrument.test.ts. Mechanism 3 is the FY throw
 * below and auTablesForPayDate; mechanism 4 is the sweeps plus the
 * monotonicity loop.
 *
 * Where the instrument disagrees with the retired annualising engine, the
 * instrument wins: the $5,000/month no-threshold case was $1,037.50 by
 * annualisation and is $1,291.00 by Schedule 1; the $12,500/month STSL case
 * was $4,337.21 and is $4,342.00. The working-holiday-maker case is gone —
 * Schedule 15 needs registration and YTD state the pack cannot see, so the
 * engine refuses WHM by name and a weekly scale-2 case takes its place.
 *
 * Amounts are decimal strings at fixed scale ("810.0000"), never floats.
 * PAYG withholds whole dollars; the .0000 is the slot's fixed scale.
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

// Monthly $5,000, threshold claimed, scale 2.
// Weekly equiv: 5,000×3/13 = 1,153.84 → 1,153 → x = 1,153.99.
// y = 0.3227×1,153.99 − 185.1935 = 372.3926 − 185.1935 = 187.1991 → $187.
// Monthly: 187×13/3 = 810.33 → $810. SG: 5,000×12% = 600.00.
test("AU golden: $5k monthly scale 2 withholds 810 + 600 SG", () => {
  const result = calculateAu2027({
    ...RESIDENT, income: "5000", pensionable: "5000",
  });
  assert.equal(result.payg, "810.0000");
  assert.equal(result.sg, "600.0000");
});

// Fortnightly $1,230.77 with STSL, scale 2 + STSL table.
// Weekly equiv: 1,230.77/2 = 615.38 → 615 → x = 615.99 (< 673 row).
// y = 0.25×615.99 − 108.2135 = 153.9975 − 108.2135 = 45.7840 → $46.
// Fortnightly: 46×2 = $92. SG: 1,230.77×12% = 147.6924 → 147.69.
test("AU golden: $1,230.77 fortnightly STSL withholds 92", () => {
  const result = calculateAu2027({
    ...RESIDENT, income: "1230.77", stslDebt: true,
    pensionable: "1230.77", periodsPerYear: 26,
  });
  assert.equal(result.payg, "92.0000");
  assert.equal(result.sg, "147.6900");
});

// Monthly $8,333.33, foreign resident, scale 3 (no Medicare in scale 3).
// Weekly equiv: 8,333.33×3/13 = 1,923.07 → 1,923 → x = 1,923.99.
// y = 0.30×1,923.99 − 0.30 = 577.1970 − 0.30 = 576.8970 → $577.
// Monthly: 577×13/3 = 2,500.33 → $2,500.
// SG: 8,333.33×12% = 999.9996 → half-up to 1,000.00.
test("AU golden: $8,333.33 foreign monthly withholds 2,500 flat", () => {
  const result = calculateAu2027({
    ...RESIDENT,
    residency: "foreign_resident",
    income: "8333.33",
    pensionable: "8333.33",
  });
  assert.equal(result.payg, "2500.0000");
  assert.equal(result.sg, "1000.0000");
});

// Monthly $5,000 WITHOUT a threshold claim, scale 1. The instrument wins:
// weekly equiv 1,153 → x = 1,153.99 (< 2,246 row).
// y = 0.32×1,153.99 − 71.6508 = 369.2768 − 71.6508 = 297.6260 → $298.
// Monthly: 298×13/3 = 1,291.33 → $1,291.
test("AU golden: $5k monthly scale 1 withholds 1,291", () => {
  const result = calculateAu2027({
    ...RESIDENT, income: "5000", claimsThreshold: false, pensionable: "5000",
  });
  assert.equal(result.payg, "1291.0000");
  assert.equal(result.sg, "600.0000");
});

// Weekly $1,000, threshold claimed, scale 2. x = 1,000.99 (< 1,282 row).
// y = 0.3227×1,000.99 − 185.1935 = 323.0195 − 185.1935 = 137.8260 → $138.
// SG: 1,000×12% = 120.00.
test("AU golden: $1k weekly scale 2 withholds 138", () => {
  const result = calculateAu2027({
    ...RESIDENT, income: "1000", pensionable: "1000", periodsPerYear: 52,
  });
  assert.equal(result.payg, "138.0000");
  assert.equal(result.sg, "120.0000");
});

// Monthly $12,500 with STSL, scale 2 + STSL table. The instrument wins:
// weekly equiv: 12,500×3/13 = 2,884.61 → 2,884 → x = 2,884.99 (< 3,577 row).
// y = 0.56×2,884.99 − 613.9154 = 1,615.5944 − 613.9154 = 1,001.6790 → $1,002.
// Monthly: 1,002×13/3 = 4,342.00 → $4,342. SG 1,500.00.
test("AU golden: $12.5k monthly STSL withholds 4,342", () => {
  const result = calculateAu2027({
    ...RESIDENT, income: "12500", stslDebt: true, pensionable: "12500",
  });
  assert.equal(result.payg, "4342.0000");
  assert.equal(result.sg, "1500.0000");
});

// Scale-1 weekly edges (x = w + 0.99):
// 187 → 0.15×187.99−0.15 = 28.0485 → 28; 188 → next row, 28.3670 → 28;
// 370 → 66.2960 → 66; 371 → 0.179×371.99−0.1066 = 66.4796 → 66.
test("AU sweep: scale-1 weekly edges at, below and above", () => {
  const cases: Array<[string, string]> = [
    ["187", "28.0000"],
    ["188", "28.0000"],
    ["370", "66.0000"],
    ["371", "66.0000"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, income, claimsThreshold: false, pensionable: "0", periodsPerYear: 52,
    });
    assert.equal(result.payg, expected, `weekly ${income}`);
  }
});

// Scale-2 weekly edges across the $538 Medicare-shade row change:
// 537 → 0.15×537.99−54.3462 = 26.3523 → 26;
// 538 → 0.25×538.99−108.2135 = 26.5340 → 27;
// 672 → 60.0340 → 60; 673 → 0.17×673.99−54.3473 = 60.2310 → 60.
test("AU sweep: scale-2 weekly edges at, below and above", () => {
  const cases: Array<[string, string]> = [
    ["537", "26.0000"],
    ["538", "27.0000"],
    ["672", "60.0000"],
    ["673", "60.0000"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, income, pensionable: "0", periodsPerYear: 52,
    });
    assert.equal(result.payg, expected, `weekly ${income}`);
  }
});

// Scale-3 weekly edges (no Medicare anywhere in scale 3):
// 2,595 → 0.30×2,595.99−0.30 = 778.4970 → 778;
// 2,596 → 0.37×2,596.99−181.7308 = 779.1555 → 779.
test("AU sweep: scale-3 weekly edges at, below and above", () => {
  const cases: Array<[string, string]> = [
    ["2595", "778.0000"],
    ["2596", "779.0000"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT,
      residency: "foreign_resident",
      income,
      pensionable: "0",
      periodsPerYear: 52,
    });
    assert.equal(result.payg, expected, `weekly ${income}`);
  }
});

// STSL floor edges, scale 2 + STSL (below $1,337 the row repeats the base):
// 1,336 → 0.32×1,336.99−181.7319 = 246.1049 → 246;
// 1,337 → 0.47×1,337.99−382.2935 = 246.5618 → 247.
test("AU sweep: STSL floor edges switch tables without a cliff", () => {
  const cases: Array<[string, string]> = [
    ["1336", "246.0000"],
    ["1337", "247.0000"],
  ];
  for (const [income, expected] of cases) {
    const result = calculateAu2027({
      ...RESIDENT, income, stslDebt: true, pensionable: "0", periodsPerYear: 52,
    });
    assert.equal(result.payg, expected, `weekly ${income}`);
  }
});

// Withholding never falls as weekly pay rises (scale 2, $0–$3,700).
test("AU sweep: scale-2 withholding is monotonic in weekly pay", () => {
  let previous = -1;
  for (let weekly = 0; weekly <= 3700; weekly++) {
    const result = calculateAu2027({
      ...RESIDENT, income: String(weekly), pensionable: "0", periodsPerYear: 52,
    });
    const current = Number(result.payg);
    assert.ok(current >= previous, `weekly ${weekly}: ${current} < ${previous}`);
    previous = current;
  }
});

test("AU engine refuses no-TFN, WHM and unsupported frequencies by name", () => {
  assert.throws(
    () => calculateAu2027({ ...RESIDENT, income: "1000", pensionable: "0", periodsPerYear: 52, tfnQuoted: false }),
    /no quoted TFN/,
  );
  assert.throws(
    () => calculateAu2027({ ...RESIDENT, income: "1000", pensionable: "0", periodsPerYear: 52, workingHolidayMaker: true }),
    /working holiday makers is refused/,
  );
  assert.throws(
    () => calculateAu2027({ ...RESIDENT, income: "1000", pensionable: "0", periodsPerYear: 0 }),
    /periodsPerYear/,
  );
  for (const periodsPerYear of [1, 24]) {
    assert.throws(
      () => calculateAu2027({ ...RESIDENT, income: "1000", pensionable: "0", periodsPerYear }),
      /refused by name/,
      `${periodsPerYear} pays per year`,
    );
  }
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
