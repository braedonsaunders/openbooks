/**
 * AU 2026–27 conformance: the instrument's per-period method, its
 * transcribed tables, and the refusals.
 *
 * GOLDENS are hand-worked from the Schedule 1 / Schedule 8 coefficients in
 * ./schedule1-2027.ts (F2026L00716); the engine must reproduce each to the
 * dollar. The instrument's own sample data lives in au-instrument.test.ts.
 * Periodic pay converts to a weekly equivalent w (monthly ×3/13, fortnightly
 * /2), then x = w + 0.99, y = a·x − b rounded to the dollar, converted back.
 *
 * Where the instrument disagrees with the retired annualising engine, the
 * instrument wins: $5,000/month without the threshold was $1,037.50 and is
 * $1,291.00; the $12,500/month STSL case was $4,337.21 and is $4,342.00.
 * Working holiday makers are refused by name (Schedule 15 needs registration
 * and YTD state the pack cannot see).
 *
 * Amounts are decimal strings at fixed scale ("810.0000"), never floats.
 * PAYG withholds whole dollars; the .0000 is the slot's fixed scale.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { type Au2027Input, calculateAu2027, computeAuStatutory } from "./compute-statutory.ts";
import { toUnits } from "../../money/money.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { AU_PAYROLL_PACK } from "./pack.ts";
import {
  AU_SCHEDULE1_SCALE1_2027,
  AU_SCHEDULE1_SCALE1_STSL_2027,
  AU_SCHEDULE1_SCALE2_2027,
  AU_SCHEDULE1_SCALE2_STSL_2027,
  AU_SCHEDULE1_SCALE3_2027,
  AU_SCHEDULE1_SCALE3_STSL_2027,
  AU_SCHEDULE1_SCALE4_2027,
  AU_SCHEDULE1_SCALE5_2027,
  AU_SCHEDULE1_SCALE5_STSL_2027,
  AU_SCHEDULE1_SCALE6_2027,
  AU_SCHEDULE1_SCALE6_STSL_2027,
  AU_SCHEDULE8_STSL_NO_THRESHOLD_2027,
  AU_SCHEDULE8_STSL_THRESHOLD_2027,
} from "./schedule1-2027.ts";
import {
  AU_HELP_2027,
  AU_MEDICARE_2027,
  AU_NONRESIDENT_BANDS_2027,
  AU_REFUSED_2027,
  AU_RESIDENT_BANDS_2027,
  AU_WHM_BANDS_2027,
  auTablesForPayDate,
} from "./tax-year-2027.ts";

const RESIDENT = {
  residency: "australian_resident",
  workingHolidayMaker: false,
  claimsThreshold: true,
  medicareExemption: "none",
  tfnQuoted: true,
  stslDebt: false,
  ytdQualifying: "0",
  periodsPerYear: 12,
} as const;

type AuInput = Pick<Au2027Input, "income" | "pensionable"> & Partial<Au2027Input>;

const S1 = "F2026L00716 Schedule 1";
const S8 = "F2026L00716 Schedule 8";
const WEEKLY = { pensionable: "0", periodsPerYear: 52 } as const;
const FOREIGN = { residency: "foreign_resident" } as const;

// expectedSg is omitted for sweep rows priced with no pensionable base.
const GOLDENS: ReadonlyArray<{
  year: 2027; label: string; input: AuInput;
  expectedPayg: string; expectedSg?: string; citation: string;
}> = [
  // w 1,153 → y = 0.3227×1,153.99 − 185.1935 = 187.1991 → 187 ×13/3 → 810.
  { year: 2027, label: "$5k monthly scale 2 withholds 810 + 600 SG", citation: `${S1} scale 2`,
    input: { income: "5000", pensionable: "5000" }, expectedPayg: "810.0000", expectedSg: "600.0000" },
  // w 615 → y = 0.25×615.99 − 108.2135 = 45.7840 → 46 ×2 → 92; SG 147.6924 → 147.69.
  { year: 2027, label: "$1,230.77 fortnightly STSL withholds 92", citation: `${S8} with scale 2`,
    input: { income: "1230.77", stslDebt: true, pensionable: "1230.77", periodsPerYear: 26 },
    expectedPayg: "92.0000", expectedSg: "147.6900" },
  // w 1,923 → y = 0.30×1,923.99 − 0.30 = 576.8970 → 577 ×13/3 → 2,500; SG 999.9996 half-up.
  { year: 2027, label: "$8,333.33 foreign monthly withholds 2,500 flat", citation: `${S1} scale 3`,
    input: { ...FOREIGN, income: "8333.33", pensionable: "8333.33" },
    expectedPayg: "2500.0000", expectedSg: "1000.0000" },
  // w 1,153 → y = 0.32×1,153.99 − 71.6508 = 297.6260 → 298 ×13/3 → 1,291.
  { year: 2027, label: "$5k monthly scale 1 withholds 1,291", citation: `${S1} scale 1`,
    input: { income: "5000", claimsThreshold: false, pensionable: "5000" },
    expectedPayg: "1291.0000", expectedSg: "600.0000" },
  // y = 0.3227×1,000.99 − 185.1935 = 137.8260 → 138.
  { year: 2027, label: "$1k weekly scale 2 withholds 138", citation: `${S1} scale 2`,
    input: { income: "1000", pensionable: "1000", periodsPerYear: 52 },
    expectedPayg: "138.0000", expectedSg: "120.0000" },
  // w 2,884 → y = 0.56×2,884.99 − 613.9154 = 1,001.6790 → 1,002 ×13/3 → 4,342.
  { year: 2027, label: "$12.5k monthly STSL withholds 4,342", citation: `${S8} with scale 2`,
    input: { income: "12500", stslDebt: true, pensionable: "12500" },
    expectedPayg: "4342.0000", expectedSg: "1500.0000" },
  // y = 0.45×2,000.99 − 382.2923 = 518.1532 → 518.
  { year: 2027, label: "$2k weekly scale 5 with STSL withholds 518", citation: `${S8} with scale 5`,
    input: { income: "2000", medicareExemption: "full", stslDebt: true, pensionable: "2000", periodsPerYear: 52 },
    expectedPayg: "518.0000", expectedSg: "240.0000" },
  // y = 0.3527×1,000.99 − 230.6135 = 122.4357 → 122.
  { year: 2027, label: "$1k weekly scale 6 withholds 122", citation: `${S1} scale 6`,
    input: { income: "1000", medicareExemption: "half", pensionable: "1000", periodsPerYear: 52 },
    expectedPayg: "122.0000", expectedSg: "120.0000" },
  // Scale-1 weekly row edges: 0.15×187.99 − 0.15 = 28.0485; 0.179×371.99 − 0.1066 = 66.4796.
  ...([["187", "28"], ["188", "28"], ["370", "66"], ["371", "66"]] as const).map(([income, payg]) => ({
    year: 2027 as const, label: `scale-1 weekly edge ${income} withholds ${payg}`, citation: `${S1} scale 1`,
    input: { ...WEEKLY, income, claimsThreshold: false }, expectedPayg: `${payg}.0000`,
  })),
  // Scale-2 edges across the $538 Medicare-shade row: 0.15×537.99 − 54.3462 = 26.3523;
  // 0.25×538.99 − 108.2135 = 26.5340; 0.17×673.99 − 54.3473 = 60.2310.
  ...([["537", "26"], ["538", "27"], ["672", "60"], ["673", "60"]] as const).map(([income, payg]) => ({
    year: 2027 as const, label: `scale-2 weekly edge ${income} withholds ${payg}`, citation: `${S1} scale 2`,
    input: { ...WEEKLY, income }, expectedPayg: `${payg}.0000`,
  })),
  // Scale 3 (no Medicare): 0.30×2,595.99 − 0.30 = 778.4970; 0.37×2,596.99 − 181.7308 = 779.1555.
  ...([["2595", "778"], ["2596", "779"]] as const).map(([income, payg]) => ({
    year: 2027 as const, label: `scale-3 weekly edge ${income} withholds ${payg}`, citation: `${S1} scale 3`,
    input: { ...WEEKLY, ...FOREIGN, income }, expectedPayg: `${payg}.0000`,
  })),
  // STSL floor (below $1,337 the row repeats the base): 0.32×1,336.99 − 181.7319 = 246.1049;
  // 0.47×1,337.99 − 382.2935 = 246.5618 — tables switch without a cliff.
  ...([["1336", "246"], ["1337", "247"]] as const).map(([income, payg]) => ({
    year: 2027 as const, label: `STSL floor edge ${income} withholds ${payg}`, citation: `${S8} with scale 2`,
    input: { ...WEEKLY, income, stslDebt: true }, expectedPayg: `${payg}.0000`,
  })),
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const result = calculateAu2027({ ...RESIDENT, ...row.input });
    const where = `${row.label} (${row.citation})`;
    assert.equal(result.payg, row.expectedPayg, `PAYG: ${where}`);
    if (row.expectedSg !== undefined) assert.equal(result.sg, row.expectedSg, `SG: ${where}`);
  });
}

const REFUSALS: ReadonlyArray<{ label: string; input: Partial<Au2027Input>; refusal: RegExp }> = [
  { label: "no quoted TFN", input: { tfnQuoted: false }, refusal: /no quoted TFN/ },
  { label: "working holiday maker", input: { workingHolidayMaker: true }, refusal: /working holiday makers is refused/ },
  { label: "foreign resident with Medicare exemption", input: { ...FOREIGN, medicareExemption: "full" },
    refusal: /foreign resident claiming a Medicare/ },
  { label: "zero pays per year", input: { periodsPerYear: 0 }, refusal: /periodsPerYear/ },
  { label: "annual pay frequency", input: { periodsPerYear: 1 }, refusal: /refused by name/ },
];

for (const row of REFUSALS) {
  test(`2027 refuses ${row.label}`, () => {
    assert.throws(() => calculateAu2027({ ...RESIDENT, ...WEEKLY, income: "1000", ...row.input }), row.refusal, row.label);
  });
}

test("2027 scale-2 withholding is monotonic in weekly pay ($0–$3,700)", () => {
  let previous = -1n;
  for (let weekly = 0; weekly <= 3700; weekly++) {
    const current = toUnits(calculateAu2027({ ...RESIDENT, ...WEEKLY, income: String(weekly) }).payg);
    assert.ok(current >= previous, `weekly ${weekly}: ${current} < ${previous}`);
    previous = current;
  }
});

// Transcription spot-checks against F2026L00716 (Schedules 1 and 8) and the
// Schedule 7 / MLA / HESA + Gazette C2026G00249 figures in ./tax-year-2027.ts.
const TRANSCRIBED: ReadonlyArray<[label: string, actual: unknown, expected: unknown]> = [
  ["Schedule 1 row counts (scales 1, 2, 3, 5, 6)",
    [AU_SCHEDULE1_SCALE1_2027, AU_SCHEDULE1_SCALE2_2027, AU_SCHEDULE1_SCALE3_2027,
      AU_SCHEDULE1_SCALE5_2027, AU_SCHEDULE1_SCALE6_2027].map((t) => t.length), [7, 9, 3, 7, 9]],
  ["Schedule 8 combined row counts (scales 5, 6)",
    [AU_SCHEDULE1_SCALE5_STSL_2027.length, AU_SCHEDULE1_SCALE6_STSL_2027.length], [10, 12]],
  ["scale 1 row 3", AU_SCHEDULE1_SCALE1_2027[2], { lessThan: "515", a: "0.1790", b: "0.1066" }],
  ["scale 1 top row", AU_SCHEDULE1_SCALE1_2027[6], { lessThan: null, a: "0.4700", b: "493.1893" }],
  ["scale 2 nil row", AU_SCHEDULE1_SCALE2_2027[0], { lessThan: "362", a: null, b: null }],
  ["scale 2 top row", AU_SCHEDULE1_SCALE2_2027[8], { lessThan: null, a: "0.4700", b: "655.7704" }],
  ["scale 3 top row", AU_SCHEDULE1_SCALE3_2027[2], { lessThan: null, a: "0.4500", b: "474.0385" }],
  ["scale 4 rates", AU_SCHEDULE1_SCALE4_2027, { residentRate: "0.4700", foreignRate: "0.4500" }],
  // Below the STSL floor the combined row repeats the base coefficients.
  ["scale 2 + STSL below floor", AU_SCHEDULE1_SCALE2_STSL_2027[6], { lessThan: "1337", a: "0.3200", b: "181.7319" }],
  ["scale 1 + STSL below floor", AU_SCHEDULE1_SCALE1_STSL_2027[4], { lessThan: "987", a: "0.3200", b: "71.6508" }],
  ["scale 3 + STSL below floor", AU_SCHEDULE1_SCALE3_STSL_2027[0], { lessThan: "1337", a: "0.3000", b: "0.3000" }],
  ["scale 5 + STSL row 6", AU_SCHEDULE1_SCALE5_STSL_2027[5], { lessThan: "2494", a: "0.4500", b: "382.2923" }],
  ["scale 6 + STSL row 8", AU_SCHEDULE1_SCALE6_STSL_2027[7], { lessThan: "2494", a: "0.4600", b: "382.2923" }],
  ["Schedule 8 threshold row 2", AU_SCHEDULE8_STSL_THRESHOLD_2027[1], { lessThan: "2494", a: "0.15", b: "200.5615" }],
  ["Schedule 8 no-threshold row 2", AU_SCHEDULE8_STSL_NO_THRESHOLD_2027[1], { lessThan: "2144", a: "0.15", b: "148.0615" }],
  ["Schedule 7 Part I resident bands", AU_RESIDENT_BANDS_2027, [
    { from: "18200", upTo: "45000", rate: "0.15" }, { from: "45000", upTo: "135000", rate: "0.30" },
    { from: "135000", upTo: "190000", rate: "0.37" }, { from: "190000", upTo: null, rate: "0.45" }]],
  ["Schedule 7 Part II non-resident bands", AU_NONRESIDENT_BANDS_2027, [
    { from: "0", upTo: "135000", rate: "0.30" }, { from: "135000", upTo: "190000", rate: "0.37" },
    { from: "190000", upTo: null, rate: "0.45" }]],
  ["Schedule 7 Part III working-holiday-maker bands", AU_WHM_BANDS_2027, [
    { from: "0", upTo: "45000", rate: "0.15" }, { from: "45000", upTo: "135000", rate: "0.30" },
    { from: "135000", upTo: "190000", rate: "0.37" }, { from: "190000", upTo: null, rate: "0.45" }]],
  ["Medicare levy (MLA ss3/6/7)", AU_MEDICARE_2027,
    { rate: "0.02", threshold: "28011", phaseInLimit: "35013", shadeRate: "0.10" }],
  ["HELP (HESA + Gazette C2026G00249)", AU_HELP_2027,
    { minimumIncome: "69528", secondBandCap: "129717", firstRate: "0.15", secondRate: "0.17", incomeCapRate: "0.10" }],
];

for (const [label, actual, expected] of TRANSCRIBED) {
  test(`2027 transcribed ${label}`, () => assert.deepEqual(actual, expected, label));
}

test("2027 edition resolution accepts FY2026–27 pay dates only", () => {
  for (const payDate of ["2026-07-01", "2027-01-15", "2027-06-30"]) {
    assert.equal(auTablesForPayDate(payDate).taxYear, 2027, payDate);
  }
  for (const payDate of ["2026-06-30", "2027-07-01", "2028-01-01"]) {
    assert.throws(() => auTablesForPayDate(payDate), /no transcribed PAYG tables/, payDate);
  }
});

test("2027 refusals name every untranscribed scale and cap", () => {
  const joined = AU_REFUSED_2027.join("\n");
  for (const name of [
    "scale 4", "foreign-resident-plus-Medicare-exemption", "WLA machinery", "Schedule 15",
    "Schedules 2, 3, 4, 6, 7, 9, 10, 11, 12, 13 and 14", "surcharge", "family reduction s8",
    "160AAAA", "maximum contributions base", "repayable-debt", "53-week", "payroll tax",
  ]) {
    assert.ok(joined.includes(name), `refusal missing: ${name}`);
  }
});

// computeStatutory reads the certificate through the run context; only the
// context is stood in, the calculators and base reduction are real.
function stubCtx(overrides: Record<string, unknown> = {}) {
  const pushed: Array<{ key: string; amount: string; sequence: number }> = [];
  const ctx = {
    taxYear: 2027,
    income: "5000",
    pensionable: "5000",
    reducedBases: reduceTaxBases(
      [],
      { income: "5000", nonPeriodic: "0.0000", pensionable: "5000", insurable: "0.0000" },
      AU_PAYROLL_PACK.deductionTreatments,
    ),
    periodsPerYear: 12,
    certificateFor: () => ({
      certificate: {},
      onFile: true,
      effectiveFrom: null,
      answers: {
        tax_file_number: "123456782", residency: "australian_resident", working_holiday_maker: "false",
        tax_free_threshold: "true", stsl_debt: "false", qualifying_ytd: "0",
      },
      missing: [],
    }),
    bool: (value: string | null | undefined) => value === "true",
    pushStatutory: (key: string, _kind: string, _description: string, amount: string, sequence: number) => {
      pushed.push({ key, amount, sequence });
    },
    ...overrides,
  } as unknown as Parameters<typeof computeAuStatutory>[0];
  return { ctx, pushed };
}

test("2027 computeStatutory pushes PAYG deduction and SG employer accrual", async () => {
  const { ctx, pushed } = stubCtx();
  await computeAuStatutory(ctx);
  assert.deepEqual(pushed, [
    { key: "payg_withholding", amount: "810.0000", sequence: 110 },
    { key: "super_guarantee", amount: "600.0000", sequence: 210 },
  ]);
});

test("computeStatutory refuses untranscribed tax years by name", async () => {
  for (const taxYear of [2026, 2028]) {
    await assert.rejects(
      () => computeAuStatutory(stubCtx({ taxYear }).ctx),
      new RegExp(`tax year ${taxYear} has not been transcribed`),
    );
  }
});
