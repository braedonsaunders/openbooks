/**
 * AU 2026–27 mechanism-1 goldens: the instrument's own published outputs.
 *
 * F2026L00716 says it directly: "Payroll or accounting software written in
 * accordance with the formulas in this schedule should be tested for
 * accuracy against the 'Sample data' section in this schedule." Every
 * expected figure below is quoted from that Sample data or from the
 * schedule's worked examples; the engine must reproduce each to the dollar.
 * Quote rule: the operative text for each figure is the instrument row
 * cited in the comment above it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateAu2027 } from "./compute-statutory.ts";

const WEEKLY = {
  residency: "australian_resident",
  workingHolidayMaker: false,
  claimsThreshold: true,
  medicareExemption: "none",
  tfnQuoted: true,
  stslDebt: false,
  periodsPerYear: 52,
} as const;

const withhold = (income: string, overrides: Record<string, unknown> = {}): string =>
  calculateAu2027({ ...WEEKLY, income, pensionable: "0", ...overrides } as Parameters<typeof calculateAu2027>[0]).payg;

/**
 * "Weekly withholding amounts — Amounts to be withheld, weekly", columns
 * Scale 1 (no tax-free threshold), Scale 2 (with threshold), Scale 3
 * (foreign resident), Scale 5 (full Medicare exemption), Scale 6 (half
 * Medicare exemption). Quoted rows: "116 — 17.00 0.00 35.00 0.00 0.00",
 * "538 — 100.00 27.00 161.00 27.00 27.00",
 * "932 — 227.00 116.00 280.00 97.00 98.00",
 * "2,596 — 784.00 649.00 779.00 597.00 623.00",
 * "3,653 — 1,224.00 1,062.00 1,170.00 989.00 1,025.00".
 * Every row below is transcribed from the same table.
 */
test("AU instrument: weekly sample data scales 1, 2, 3, 5 and 6", () => {
  const rows: Array<[string, string, string, string, string, string]> = [
    ["116", "17.0000", "0.0000", "35.0000", "0.0000", "0.0000"],
    ["187", "28.0000", "0.0000", "56.0000", "0.0000", "0.0000"],
    ["188", "28.0000", "0.0000", "56.0000", "0.0000", "0.0000"],
    ["361", "64.0000", "0.0000", "108.0000", "0.0000", "0.0000"],
    ["362", "65.0000", "0.0000", "109.0000", "0.0000", "0.0000"],
    ["370", "66.0000", "1.0000", "111.0000", "1.0000", "1.0000"],
    ["371", "66.0000", "1.0000", "111.0000", "1.0000", "1.0000"],
    ["514", "92.0000", "23.0000", "154.0000", "23.0000", "23.0000"],
    ["515", "92.0000", "23.0000", "154.0000", "23.0000", "23.0000"],
    ["537", "99.0000", "26.0000", "161.0000", "26.0000", "26.0000"],
    ["538", "100.0000", "27.0000", "161.0000", "27.0000", "27.0000"],
    ["672", "143.0000", "60.0000", "202.0000", "47.0000", "47.0000"],
    ["673", "143.0000", "60.0000", "202.0000", "47.0000", "47.0000"],
    ["720", "158.0000", "68.0000", "216.0000", "54.0000", "54.0000"],
    ["721", "159.0000", "68.0000", "216.0000", "54.0000", "54.0000"],
    ["864", "205.0000", "94.0000", "259.0000", "77.0000", "77.0000"],
    ["865", "205.0000", "94.0000", "259.0000", "77.0000", "77.0000"],
    ["907", "219.0000", "108.0000", "272.0000", "90.0000", "90.0000"],
    ["908", "219.0000", "108.0000", "272.0000", "90.0000", "90.0000"],
    ["931", "227.0000", "116.0000", "279.0000", "97.0000", "98.0000"],
    ["932", "227.0000", "116.0000", "280.0000", "97.0000", "98.0000"],
    ["1134", "292.0000", "181.0000", "340.0000", "158.0000", "170.0000"],
    ["1135", "292.0000", "181.0000", "340.0000", "159.0000", "170.0000"],
    ["1281", "339.0000", "229.0000", "384.0000", "203.0000", "216.0000"],
    ["1282", "339.0000", "229.0000", "385.0000", "203.0000", "216.0000"],
    ["2245", "647.0000", "537.0000", "673.0000", "492.0000", "515.0000"],
    ["2246", "647.0000", "537.0000", "674.0000", "492.0000", "515.0000"],
    ["2595", "784.0000", "649.0000", "778.0000", "597.0000", "623.0000"],
    ["2596", "784.0000", "649.0000", "779.0000", "597.0000", "623.0000"],
    ["3302", "1059.0000", "925.0000", "1040.0000", "859.0000", "892.0000"],
    ["3303", "1060.0000", "925.0000", "1041.0000", "859.0000", "892.0000"],
    ["3652", "1224.0000", "1061.0000", "1170.0000", "988.0000", "1025.0000"],
    ["3653", "1224.0000", "1062.0000", "1170.0000", "989.0000", "1025.0000"],
  ];
  for (const [weekly, s1, s2, s3, s5, s6] of rows) {
    assert.equal(withhold(weekly, { claimsThreshold: false }), s1, `scale 1 weekly ${weekly}`);
    assert.equal(withhold(weekly), s2, `scale 2 weekly ${weekly}`);
    assert.equal(withhold(weekly, { residency: "foreign_resident" }), s3, `scale 3 weekly ${weekly}`);
    assert.equal(withhold(weekly, { medicareExemption: "full" }), s5, `scale 5 weekly ${weekly}`);
    assert.equal(withhold(weekly, { medicareExemption: "half" }), s6, `scale 6 weekly ${weekly}`);
  }
});

/**
 * Fortnightly sample data, scale 2: "1,074 — 52.00", "1,076 — 54.00".
 * Weekly equivalents 537 and 538 give $26 and $27, doubled.
 */
test("AU instrument: fortnightly sample data doubles the weekly figure", () => {
  const fortnightly = (income: string): string =>
    calculateAu2027({ ...WEEKLY, income, pensionable: "0", periodsPerYear: 26 }).payg;
  assert.equal(fortnightly("1074"), "52.0000");
  assert.equal(fortnightly("1076"), "54.0000");
});

/**
 * Monthly sample data, scale 2: "2,331.33 — 117.00" pins the 33-cent rule
 * ("if the result is an amount ending in 33 cents, add one cent"):
 * 2,331.33 → 2,331.34 × 3 / 13 = 538.00 → x = 538.99 → $27 weekly →
 * 27 × 13 / 3 = $117. "2,227.33 — 100.00" checks the same path one row down.
 */
test("AU instrument: monthly sample data pins the 33-cent rule", () => {
  const monthly = (income: string): string =>
    calculateAu2027({ ...WEEKLY, income, pensionable: "0", periodsPerYear: 12 }).payg;
  assert.equal(monthly("2331.33"), "117.0000");
  assert.equal(monthly("2227.33"), "100.0000");
});

/**
 * Monthly sample data, scales 5 and 6: "4,914.00 — 685.00 737.00" and
 * "4,918.33 — 689.00 737.00" (scale-1/scale-2/scale-3 columns read 1,265.00
 * 784.00 1,473.00 on both rows). Weekly equivalent of 4,914 is 1,134.00 →
 * x = 1,134.99: scale 5 gives 0.3027×1,134.99−185.1923 = 158.3690 → $158,
 * 158×13/3 = 684.67 → $685; scale 6 gives $170 weekly, 170×13/3 = 736.67
 * → $737. The 4,918.33 row moves scale 5 to $159 weekly → $689 monthly.
 */
test("AU instrument: monthly sample data scales 5 and 6", () => {
  const monthly = (income: string, medicareExemption: "full" | "half"): string =>
    calculateAu2027({ ...WEEKLY, income, medicareExemption, pensionable: "0", periodsPerYear: 12 }).payg;
  assert.equal(monthly("4914", "full"), "685.0000");
  assert.equal(monthly("4914", "half"), "737.0000");
  assert.equal(monthly("4918.33", "full"), "689.0000");
  assert.equal(monthly("4918.33", "half"), "737.0000");
});

/**
 * General example 2: fortnightly "$1,299.30" with a TFN declaration that
 * claims the tax-free threshold AND "a Medicare levy variation declaration
 * claiming a full exemption from the Medicare levy. Therefore, Scale 5 is
 * applied. Convert to weekly equivalent = (1,299.30 ÷ 2) = 649.65 or $649
 * (ignore cents)", "x = 649.99", "Weekly withholding amount (y) = ...
 * (0.1500 × 649.99) – 54.3462 = 43.1523 or $43.00", "Fortnightly
 * withholding amount $43.00 × 2 = $86.00". Only the $86 withholding is
 * asserted: the $63 tax offset needs a Withholding declaration the pack
 * does not carry. This example is also the precedence proof — threshold
 * claimed, yet scale 5.
 */
test("AU instrument: general example 2 withholds $86 fortnightly on scale 5", () => {
  const result = calculateAu2027({
    ...WEEKLY, income: "1299.30", medicareExemption: "full", pensionable: "0", periodsPerYear: 26,
  });
  assert.equal(result.payg, "86.0000");
});

/**
 * General example 1: "Payee's weekly earnings are $1,333.45" on scale 2 —
 * "x = 1,333.99", "Weekly withholding amount (y) = (a × x) − b =
 * (0.3200 × 1,333.99) – 181.7319 = 245.1449 or $245 (rounded to nearest
 * dollar)". Only the withholding part is asserted: the example's $26 levy
 * adjustment needs a Medicare levy variation declaration the pack refuses.
 */
test("AU instrument: general example 1 withholds $245 weekly", () => {
  assert.equal(withhold("1333.45"), "245.0000");
});

/**
 * General example 3: "Payee's monthly earnings are $5,400.33" on scale 2 —
 * "Convert to weekly equivalent = ($5,400.33 + 0.01) × 3 ÷ 13 = 1,246.2323
 * or $1,246", "x = 1,246.99", "Weekly withholding amount (y) = ...
 * (0.3227 × 1,246.99) – 185.1935 = 217.2102 or $217.00", "Monthly
 * withholding amount $217.00 × 13 ÷ 3 = $940.00". The $113 tax offset is
 * quoted but not applied: no Withholding declaration is carried.
 */
test("AU instrument: general example 3 withholds $940 monthly", () => {
  const monthly = calculateAu2027({ ...WEEKLY, income: "5400.33", pensionable: "0", periodsPerYear: 12 });
  assert.equal(monthly.payg, "940.0000");
});

/**
 * Schedule 8 example 1: threshold claimed, "weekly earnings of $2,608.36",
 * "x = 2,608.99", "Weekly withholding amount (y) = ... (0.1700 × 2,608.99)
 * – 250.4527 = 193.0756 or $193.00" — that is the STSL COMPONENT. The
 * engine withholds the combined total ($847); the component is pinned as
 * combined-minus-base: base scale 2 gives $654, and 847 − 654 = 193.
 */
test("AU instrument: STSL example 1 component is $193 of $847", () => {
  const base = withhold("2608");
  const combined = withhold("2608", { stslDebt: true });
  assert.equal(base, "654.0000");
  assert.equal(combined, "847.0000");
  assert.equal(Number(combined) - Number(base), 193);
});

/**
 * Schedule 8 example 2: threshold claimed, "fortnightly earnings of
 * $4,409.75" — "Convert to weekly equivalent = 4,409.75 ÷ 2 = 2,204.88 or
 * $2,204", "x = 2,204.99", "Weekly withholding amount (y) = ...
 * (0.1500 × 2,204.99) – 200.5615 = 130.1870 or $130.00", "Convert back to
 * fortnightly = 260.00 (130.00 × 2)". Combined fortnightly $1,308 minus
 * base $1,048 is the published $260 component.
 */
test("AU instrument: STSL example 2 component is $260 of $1,308", () => {
  const opts = { periodsPerYear: 26 };
  const base = withhold("4409.75", opts);
  const combined = withhold("4409.75", { ...opts, stslDebt: true });
  assert.equal(base, "1048.0000");
  assert.equal(combined, "1308.0000");
  assert.equal(Number(combined) - Number(base), 260);
});

/**
 * Schedule 8 example 3: NO threshold claimed, "monthly earnings of
 * $10,627.88" — "Convert to weekly equivalent = 10,627.88 × 3 ÷ 13 =
 * 2,452.59 or $2,452", "x = 2,452.99", "Weekly withholding amount (y) = ...
 * (0.1700 × 2,452.99) – 190.9527 = 226.0556 or $226.00", "Convert back to
 * monthly = 979.33 (226.00 × 13 ÷ 3)", "Monthly STSL component = $979".
 * Combined monthly $4,134 minus base $3,155 is the published $979.
 */
test("AU instrument: STSL example 3 component is $979 of $4,134", () => {
  const opts = { periodsPerYear: 12, claimsThreshold: false };
  const base = withhold("10627.88", opts);
  const combined = withhold("10627.88", { ...opts, stslDebt: true });
  assert.equal(base, "3155.0000");
  assert.equal(combined, "4134.0000");
  assert.equal(Number(combined) - Number(base), 979);
});
