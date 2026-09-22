/**
 * GB gold-parity harness — run with `node --import tsx
 * engine/src/payroll/gb/parity.test.ts`.
 *
 * Four mechanisms, matching Canada's harness:
 * 1. EXTERNAL GOLDENS lifted from HMRC's own publications (CWG2's Jason
 *    example, the K475 and 1257L guide examples, Tax Tables B-D's BR worked
 *    example). Authority numbers are hardcoded with their quotes; any drift
 *    in our constants fails loudly.
 * 2. HAND-WORKED CASES derived step by step from the tables, independent of
 *    the engine, with the arithmetic shown.
 * 3. EDITION RESOLUTION that throws outside 2026/27 — never extrapolates.
 * 4. A SWEEP over band boundaries (at, below, above) plus a monotonicity
 *    pass across the pay scale.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money/money.ts";
import {
  calculateGbNic,
  calculateGbPaye,
  gbNicThresholdsForPeriod,
  gbCvalueUnits,
  gbTablesAValueUnits,
  gbResolveTaxYear,
  gbRoundPennyUnits,
  gbRukLiabilityUnits,
  gbTaxMonthNumber,
  gbTaxWeekNumber,
  resolveGbCumulativeBasis,
} from "./calculate.ts";
import { parseGbTaxCode } from "./tax-codes.ts";

// ---------------------------------------------------------------------------
// Mechanism 1: external goldens (HMRC's numbers, hardcoded)
// ---------------------------------------------------------------------------

test("golden: CWG2 Jason weekly £300 pays £4.64 employee NIC", () => {
  // CWG2 2026/27, exact percentage method: "(£300 – £242) × 8% ... 58 × 8%
  // = £4.64". Category M and A share the 8%/2% employee schedule, so the
  // employee share transfers; the £0.00 employer share does not (M has a 0%
  // secondary band to its UST — asserted in the M-only test below).
  const result = calculateGbNic({ earnings: "300", periodsPerYear: 52 });
  assert.equal(result.employee, "4.6400");
});

test("golden: CWG2 Jason combined week £2,300 pays £84.66 employee NIC", () => {
  // "(£967 – £242) = £725 × 8% = £58.00; (£2,300 – £967) = £1,333 × 2% =
  // £26.66; £58.00 + £26.66 = £84.66".
  const result = calculateGbNic({ earnings: "2300", periodsPerYear: 52 });
  assert.equal(result.employee, "84.6600");
});

test("golden: K475 on £27,000 prices £31,750 of taxable income", () => {
  // Letters page: "An employee with tax code K475 and a salary of £27,000
  // has taxable income of £31,750 (£27,000 plus £4,750)." £31,750 at rUK
  // rates is £6,350.00 of annual liability — the band engine must agree.
  const code = parseGbTaxCode("K475");
  assert.equal(code.kind, "k");
  assert.equal((code as { number: number }).number, 475);
  assert.equal(gbRukLiabilityUnits(3_175_000_00n), 635_000_00n);
});

test("golden: 1257L on £27,000 prices £14,430 of taxable income", () => {
  // Numbers page: "an employee with the tax code 1257L can earn £12,570
  // before being taxed. If they earn £27,000 per year, their taxable income
  // is £14,430." £14,430 × 20% = £2,886.00.
  assert.equal(gbRukLiabilityUnits(1_443_000_00n), 288_600_00n);
});

test("golden: Tax Tables B-D BR example £3,200 × 20% = £640.00", () => {
  // "£3,200 x 0.20 = £640.00" (Example 2, codes BR/SBR/CBR).
  const result = calculateGbPaye({
    code: parseGbTaxCode("BR"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "3200",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "3200",
  });
  assert.equal(result.tax, "640.0000");
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked cases (arithmetic shown, engine-independent)
// ---------------------------------------------------------------------------

test("hand-worked: monthly £4,000 1257L month 3, no priors → £171.00", () => {
  // Spec §4: free pay to date = 3 × Month1(1257) = 3 × £1,048.26 (Tables A:
  // 1257 = 2 chunks + remainder 257 → £214.92 + 2 × £416.67). Cumulative pay
  // £4,000, so Un = £855.22, Tn = £855. Income Test 1: 855.22 ≤ month-3
  // Cvalue £9,425 → Formula 1: £855 × 20% = £171.00, floored. Nothing paid.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2026-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
  });
  assert.equal(result.tax, "171.0000");
});

test("hand-worked: category-A employer NIC £300/wk → £30.60", () => {
  // (300 − 96) × 15% = 204 × 15% = £30.60. (Jason's £0.00 is the
  // category-M 0%-to-UST schedule, which this pack does not operate.)
  const result = calculateGbNic({ earnings: "300", periodsPerYear: 52 });
  assert.equal(result.employer, "30.6000");
});

test("hand-worked: category-A employer NIC £2,000/mo → £237.45", () => {
  // (2,000 − 417) × 15% = 1,583 × 15% = £237.45.
  const result = calculateGbNic({ earnings: "2000", periodsPerYear: 12 });
  assert.equal(result.employer, "237.4500");
});

test("hand-worked: employee NIC crosses PT and UEL", () => {
  // £1,048/mo is exactly monthly PT: nothing due.
  assert.equal(
    calculateGbNic({ earnings: "1048", periodsPerYear: 12 }).employee,
    "0.0000",
  );
  // £4,189/mo is exactly monthly UEL: (4,189 − 1,048) × 8% = 3,141 × 8% = £251.28.
  assert.equal(
    calculateGbNic({ earnings: "4189", periodsPerYear: 12 }).employee,
    "251.2800",
  );
  // £5,000/mo: 251.28 + (5,000 − 4,189) × 2% = 251.28 + 16.22 = £267.50.
  assert.equal(
    calculateGbNic({ earnings: "5000", periodsPerYear: 12 }).employee,
    "267.5000",
  );
});

test("hand-worked: full 2026/27 on £27,000 sums to £2,884.00", () => {
  // Twelve monthly £2,250 periods, cumulative 1257L. Month 1 deducts £240.20
  // (free £1,048.26, Un £1,201.74, Tn £1,201 × 20%); later months ripple
  // ±41p as each month's formula floors independently — the spec prices
  // every month, it does not copy month 1. The year telescopes to the
  // annual liability on Tn £14,420 (27,000 − 12 × 1,048.26): × 20% =
  // £2,884.00.
  const code = parseGbTaxCode("1257L");
  let priorTaxable = "0.0000";
  let priorPaid = "0.0000";
  let total = 0n;
  const payDates = [
    "2026-04-06", "2026-05-06", "2026-06-06", "2026-07-06", "2026-08-06",
    "2026-09-06", "2026-10-06", "2026-11-06", "2026-12-06", "2027-01-06",
    "2027-02-06", "2027-03-06",
  ];
  payDates.forEach((payDate, index) => {
    const result = calculateGbPaye({
      code, payDate, periodsPerYear: 12,
      periodPay: "2250", priorTaxablePay: priorTaxable, priorAddedPay: "0",
      priorTaxPaid: priorPaid, periodGrossPay: "2250",
    });
    if (index === 0) assert.equal(result.tax, "240.2000");
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 2250).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal(total, 288_400_00n);
});

test("hand-worked: K code caps the period deduction at half of gross pay", () => {
  // K2000, month 12, £500 of pay, no priors: added to date 12 × £1,666.68
  // (§4.3.1c: remainder 500 → ceiling(5,000/12) + 3 × £416.67) = £20,000.16,
  // cumulative taxable £20,500.16, liability far above half of pay — the
  // §4.5.2 Maxrate cap holds the deduction at £250.
  const result = calculateGbPaye({
    code: parseGbTaxCode("K2000"),
    payDate: "2027-03-06",
    periodsPerYear: 12,
    periodPay: "500",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "500",
  });
  assert.equal(result.tax, "250.0000");
});

test("hand-worked: 0T prices full pay through the bands, NT prices nothing", () => {
  // 0T, month 2, £5,000, no priors: cumulative taxable £5,000 × 20% = £1,000.
  const zeroT = calculateGbPaye({
    code: parseGbTaxCode("0T"),
    payDate: "2026-05-06",
    periodsPerYear: 12,
    periodPay: "5000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "5000",
  });
  assert.equal(zeroT.tax, "1000.0000");
  const nt = calculateGbPaye({
    code: parseGbTaxCode("NT"),
    payDate: "2026-05-06",
    periodsPerYear: 12,
    periodPay: "5000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "5000",
  });
  assert.equal(nt.tax, "0.0000");
});

test("golden: Cvalues match HMRC Tax Tables B-D Column 1", () => {
  // Spec Definitions 9–10: the Income-Test tops are the exact thresholds
  // ceiled to the pound. They are the round-pound Column 1 figures in Tax
  // Tables B-D ("Manual Method"), April 2023 edition (p.4, English monthly:
  // 3142, 6284, 9425 ... 37700; weekly: 725, 1450 ... 37700 — the annual
  // bands there are £37,700/£125,140, frozen ever since, so the rows pin the
  // 2026/27 values too). The month-2 figure discriminates the rounding:
  // 37,700 × 2/12 = 6,283.33 prints 6,284 — ceiling, not round-half-up.
  // Cvalues CHOOSE the formula; the tax itself prices through the exact
  // thresholds (§2.5) — see the £10,000 test below.
  assert.equal(gbCvalueUnits("37700", 12, 1), 314_200_00n);
  assert.equal(gbCvalueUnits("37700", 12, 2), 628_400_00n);
  assert.equal(gbCvalueUnits("37700", 12, 12), 3_770_000_00n);
  assert.equal(gbCvalueUnits("37700", 52, 1), 72_500_00n);
  assert.equal(gbCvalueUnits("125140", 12, 1), 1_042_900_00n);
  assert.equal(gbCvalueUnits("125140", 52, 1), 240_700_00n);
});

test("golden: Tables-A values follow the §4.3.1 decomposition", () => {
  // 1257L month 1: 1257 = 2 × 500 + 257 → remainder value
  // ceiling(2,579/12) = £214.92 plus 2 × £416.67 = £1,048.26. Week 1:
  // ceiling(2,579/52) = £49.60 plus 2 × £96.16 = £241.92. K475 month 1
  // (no +9): ceiling(4,750/12) = £395.84. Each verified against the
  // Tables-A lookup the spec automates (§4.3.1c).
  assert.equal(gbTablesAValueUnits(1257, 12, 1, "free"), 104_826_00n);
  assert.equal(gbTablesAValueUnits(1257, 52, 1, "free"), 24_192_00n);
  assert.equal(gbTablesAValueUnits(1257, 12, 3, "free"), 3n * 104_826_00n);
  assert.equal(gbTablesAValueUnits(475, 12, 1, "additional"), 39_584_00n);
  assert.equal(gbTablesAValueUnits(0, 12, 1, "free"), 0n);
  // Manual Example 3's Tables-A leg (p.4): code 431L at week 11. 431 needs
  // no decomposition (quotient 0, remainder 431): 11 × ceiling(4,319/52) =
  // 11 × £83.06 = £913.66 — the figure the example subtracts.
  assert.equal(gbTablesAValueUnits(431, 52, 11, "free"), 91_366_00n);
});

test("golden: manual Examples 5 and 6 price through this engine unchanged", () => {
  // Tax Tables B-D pp.7–8, worked examples on the 2023/24 print (whose rUK
  // bands match 2026/27). Both use whole-pound taxable pay with no free pay,
  // so a 0T month-4 period replays them exactly:
  // - Example 5: Tn £20,300 → Formula 2 on the exact month-4 threshold
  //   (£12,566.6666) and threshold tax (£2,513.3333): £2,513.3333 +
  //   (20,300 − 12,566.6666) = 7,733.3334 × 40% = £3,093.3333 → £5,606.6666
  //   floored to £5,606.66 (the example's £3,093.20 + £2,513.46).
  // - Example 6: Tn £49,214 → Formula 3 on £41,713.3333 / £14,172.00:
  //   £14,172.00 + (49,214 − 41,713.3333) = 7,500.6667 × 45% = £3,375.30 →
  //   £17,547.30 (the example's £3,375.00 + £14,172.30).
  const ex5 = calculateGbPaye({
    code: parseGbTaxCode("0T"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "20300",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "20300",
  });
  assert.equal(ex5.tax, "5606.6600");
  const ex6 = calculateGbPaye({
    code: parseGbTaxCode("0T"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "49214",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "49214",
  });
  assert.equal(ex6.tax, "17547.3000");
});

test("golden: 1257L £10,000 in month 1 withholds £2,952.06", () => {
  // The defect this pins: pricing a month-1 period through the ANNUAL bands
  // withholds ~£1,790 (all 20%). The spec prices month 1 through Formula 2
  // (§4.4.4): free pay £1,048.26, Un = £8,951.74, Tn = £8,951; Income Test 2
  // (8,951.74 ≤ higher Cvalue £10,429) selects it. Exact month-1 threshold
  // 37,700/12 = £3,141.6666 and threshold tax 7,540/12 = £628.3333:
  // £628.3333 + (8,951 − 3,141.6666) = 5,809.3334 × 40% = £2,323.7333 →
  // £2,952.0666, floored to £2,952.06. Pricing through the printed £3,142
  // Cvalue instead gives £2,952.30 — pennies off the spec (§2.5).
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2026-04-06",
    periodsPerYear: 12,
    periodPay: "10000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "10000",
  });
  assert.equal(result.tax, "2952.0600");
});

test("hand-worked: month-7 cumulative higher earner, £10,000 a month", () => {
  // Six £10,000 months behind (£60,000, £17,714.00 paid — the true chain),
  // £10,000 in month 7: free pay to date 7 × £1,048.26 = £7,337.82, Un =
  // £62,662.18, Tn = £62,662. Income Test 2 (62,662.18 ≤ £72,999) selects
  // Formula 2 on the exact month-7 threshold (37,700 × 7/12 = £21,991.6666)
  // and threshold tax (7,540 × 7/12 = £4,398.3333): £4,398.3333 +
  // (62,662 − 21,991.6666) = 40,670.3334 × 40% = £16,268.1333 → £20,666.4666
  // floored to £20,666.46 to date, less £17,714.00 paid = £2,952.46 due.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2026-10-06",
    periodsPerYear: 12,
    periodPay: "10000",
    priorTaxablePay: "60000.0000",
    priorAddedPay: "0",
    priorTaxPaid: "17714.0000",
    periodGrossPay: "10000",
  });
  assert.equal(result.tax, "2952.4600");
});

test("hand-worked: week-53 payment prices non-cumulatively on Week 1 (§14)", () => {
  // 2027-04-05 is week 53 of 2026/27. A cumulative 1257L code still prices
  // it on the Week 1 tables, non-cumulatively: free £241.92, Un = £2,008.08,
  // Tn = £2,008; Income Test 2 (2,008.08 ≤ £2,407) selects Formula 2:
  // week-1 threshold tax 7,540/52 = £145.00 plus (2,008 − 725) = 1,283 × 40%
  // = £513.20 → £658.20. Priors are ignored even when supplied.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2027-04-05",
    periodsPerYear: 52,
    periodPay: "2250",
    priorTaxablePay: "99999.0000",
    priorAddedPay: "0",
    priorTaxPaid: "9999.0000",
    periodGrossPay: "2250",
  });
  assert.equal(result.tax, "658.2000");
});

test("hand-worked: weekly W1 £2,500 prices through week-1 bands", () => {
  // Period free £241.92 (§4.3.1c); Un = £2,258.08, Tn = £2,258. Income
  // Test 2 (2,258.08 ≤ £2,407) selects Formula 2: week-1 threshold tax
  // 7,540/52 = £145.00 plus (2,258 − 725) = 1,533 × 40% = £613.20 → £758.20,
  // floored. Tn truncation of the 8p costs 4p of tax against exact pennies.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L W1"),
    payDate: "2026-04-08",
    periodsPerYear: 52,
    periodPay: "2500",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "2500",
  });
  assert.equal(result.tax, "758.2000");
});

test("hand-worked: full 2026/27 on £60,000 telescopes to £11,428.00", () => {
  // Twelve monthly £5,000 periods, cumulative 1257L: the year must telescope
  // to the annual liability on Tn £47,420 (60,000 − 12 × 1,048.26):
  // 37,700 × 20% = £7,540 plus 9,720 × 40% = £3,888 → £11,428.00. Each
  // month's formula floors independently, so months ripple 952.06–952.47;
  // only month 1 and the year total are pinned.
  const code = parseGbTaxCode("1257L");
  let priorTaxable = "0.0000";
  let priorPaid = "0.0000";
  let total = 0n;
  const payDates = [
    "2026-04-06", "2026-05-06", "2026-06-06", "2026-07-06", "2026-08-06",
    "2026-09-06", "2026-10-06", "2026-11-06", "2026-12-06", "2027-01-06",
    "2027-02-06", "2027-03-06",
  ];
  payDates.forEach((payDate, index) => {
    const result = calculateGbPaye({
      code, payDate, periodsPerYear: 12,
      periodPay: "5000", priorTaxablePay: priorTaxable, priorAddedPay: "0",
      priorTaxPaid: priorPaid, periodGrossPay: "5000",
    });
    if (index === 0) assert.equal(result.tax, "952.0600");
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 5000).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal(total, 1_142_800_00n);
});

test("hand-worked: non-cumulative K code prices added pay through month-1 bands", () => {
  // K475 M1 on £2,250: added pay ceiling(4,750/12) = £395.84 (§4.3.1c, no
  // +9 for K), Un = £2,645.84, Tn = £2,645; Income Test 1 (2,645.84 ≤
  // £3,142) selects Formula 1: £2,645 × 20% = £529.00, floored. The §4.5.2
  // cap (£1,125) does not bind.
  const result = calculateGbPaye({
    code: parseGbTaxCode("K475 M1"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "2250",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "2250",
  });
  assert.equal(result.tax, "529.0000");
  assert.equal(result.periodAddedPay, "395.8400");
});

test("hand-worked: W1 ignores year to date by definition", () => {
  // 1257L W1 on £2,250 with £9,999.99 already (wrongly) paid: period free
  // £1,048.26, Un = £1,201.74, Tn = £1,201 → Formula 1: £240.20 — priors
  // untouched.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L W1"),
    payDate: "2027-03-06",
    periodsPerYear: 12,
    periodPay: "2250",
    priorTaxablePay: "20000",
    priorAddedPay: "0",
    priorTaxPaid: "9999.99",
    periodGrossPay: "2250",
  });
  assert.equal(result.tax, "240.2000");
});

// ---------------------------------------------------------------------------
// Rounding: Regulation 12(1), including the exact-half edge
// ---------------------------------------------------------------------------

test("penny rounding disregards a half-penny or less", () => {
  assert.equal(gbRoundPennyUnits(49n), 0n);
  assert.equal(gbRoundPennyUnits(50n), 0n);
  assert.equal(gbRoundPennyUnits(51n), 100n);
});

test("NIC at an exact half-penny of liability rounds down", () => {
  // £242.0625/week: 0.0625 above PT × 8% = £0.005 exactly → disregarded.
  assert.equal(
    calculateGbNic({ earnings: "242.0625", periodsPerYear: 52 }).employee,
    "0.0000",
  );
  // £242.0638/week: 0.0638 × 8% = £0.005104 → £0.01.
  assert.equal(
    calculateGbNic({ earnings: "242.0638", periodsPerYear: 52 }).employee,
    "0.0100",
  );
});

// ---------------------------------------------------------------------------
// Mechanism 3: edition resolution refuses outside 2026/27
// ---------------------------------------------------------------------------

test("pay dates outside the transcribed years throw, boundary dates resolve", () => {
  assert.equal(gbResolveTaxYear("2026-04-06"), 2026);
  assert.equal(gbResolveTaxYear("2027-04-05"), 2026);
  assert.equal(gbResolveTaxYear("2026-12-25"), 2026);
  // Prior years resolve to their own tables (rates-2025.ts, rates-2024.ts);
  // only dates outside every transcribed year throw.
  assert.equal(gbResolveTaxYear("2025-04-06"), 2025);
  assert.equal(gbResolveTaxYear("2024-04-06"), 2024);
  for (const date of ["2024-04-05", "2027-04-06", "2023-06-06", "2028-01-01", "2027-06-06"]) {
    assert.throws(() => gbResolveTaxYear(date), /no transcribed tables/, date);
  }
});

// ---------------------------------------------------------------------------
// Cumulative basis: complete record computes, gapped record refuses by name
// ---------------------------------------------------------------------------

test("cumulative basis allows month-1, declaration A, C-with-stubs, year-spanning stubs", () => {
  resolveGbCumulativeBasis({
    payDate: "2026-04-06", starterDeclaration: null, hasStubs: false, minStubPayDate: null,
  });
  resolveGbCumulativeBasis({
    payDate: "2026-11-06", starterDeclaration: "A", hasStubs: false, minStubPayDate: null,
  });
  resolveGbCumulativeBasis({
    payDate: "2026-11-06", starterDeclaration: "C", hasStubs: true, minStubPayDate: "2026-08-06",
  });
  resolveGbCumulativeBasis({
    payDate: "2026-11-06", starterDeclaration: null, hasStubs: true, minStubPayDate: "2026-04-06",
  });
});

test("cumulative basis refuses P45 gaps, adopter gaps and declaration-B history", () => {
  // P45 joiner: nothing on file after month 1.
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2026-11-06", starterDeclaration: null, hasStubs: false, minStubPayDate: null,
    }),
    /complete in-year record/,
  );
  // Mid-year adopter: stubs start in October.
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2026-11-06", starterDeclaration: null, hasStubs: true, minStubPayDate: "2026-10-06",
    }),
    /complete in-year record/,
  );
  // Declaration B: old-employer pay exists outside the product.
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2026-11-06", starterDeclaration: "B", hasStubs: true, minStubPayDate: "2026-08-06",
    }),
    /complete in-year record/,
  );
  // Declaration C with no stubs yet: nothing prices this job's record.
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2026-11-06", starterDeclaration: "C", hasStubs: false, minStubPayDate: null,
    }),
    /complete in-year record/,
  );
});

// ---------------------------------------------------------------------------
// Mechanism 4: sweep across every band boundary
// ---------------------------------------------------------------------------

test("sweep: rUK liability at, below and above each band edge", () => {
  // Basic top £37,700: below/at/above by a penny.
  assert.equal(gbRukLiabilityUnits(3_769_999_00n), 753_999_80n);
  assert.equal(gbRukLiabilityUnits(3_770_000_00n), 754_000_00n);
  assert.equal(gbRukLiabilityUnits(3_770_001_00n), 754_000_40n);
  // Additional threshold £125,140: 7,540 + 87,440 × 40% = £42,516.
  assert.equal(gbRukLiabilityUnits(12_513_999_00n), 4_251_599_60n);
  assert.equal(gbRukLiabilityUnits(12_514_000_00n), 4_251_600_00n);
  assert.equal(gbRukLiabilityUnits(12_514_001_00n), 4_251_600_45n);
});

test("sweep: NIC at, below and above PT, ST and UEL", () => {
  const weekly = (earnings: string) => calculateGbNic({ earnings, periodsPerYear: 52 });
  assert.equal(weekly("241.99").employee, "0.0000");
  assert.equal(weekly("242").employee, "0.0000");
  assert.equal(weekly("242.50").employee, "0.0400");
  assert.equal(weekly("95.99").employer, "0.0000");
  assert.equal(weekly("96").employer, "0.0000");
  assert.equal(weekly("100").employer, "0.6000");
  assert.equal(weekly("967").employee, "58.0000");
  assert.equal(weekly("968").employee, "58.0200");
});

test("sweep: PAYE and NIC never decrease as pay rises, 0 to £20,000 monthly", () => {
  const code = parseGbTaxCode("1257L W1");
  let lastTax = "0.0000";
  let lastEe = "0.0000";
  let lastEr = "0.0000";
  for (let pence = 0; pence <= 2_000_000; pence += 25_000) {
    const pay = (pence / 100).toFixed(2);
    const paye = calculateGbPaye({
      code, payDate: "2026-07-06", periodsPerYear: 12,
      periodPay: pay, priorTaxablePay: "0", priorAddedPay: "0",
      priorTaxPaid: "0", periodGrossPay: pay,
    });
    const nic = calculateGbNic({ earnings: pay, periodsPerYear: 12 });
    // Canonical 4dp strings are not zero-padded to equal width, so compare
    // numerically — lexicographic order breaks past £99.99.
    assert.ok(toUnits(paye.tax) >= toUnits(lastTax), `${pay}: ${paye.tax} < ${lastTax}`);
    assert.ok(toUnits(nic.employee) >= toUnits(lastEe), `${pay}: ${nic.employee} < ${lastEe}`);
    assert.ok(toUnits(nic.employer) >= toUnits(lastEr), `${pay}: ${nic.employer} < ${lastEr}`);
    lastTax = paye.tax;
    lastEe = nic.employee;
    lastEr = nic.employer;
  }
  // The top of the sweep lands in the additional band. A W1 period prices
  // Formula 3 on the exact month-1 threshold (125,140/12 = £10,428.3333)
  // and threshold tax (42,516/12 = £3,543.00): Un = £18,951.74, Tn =
  // £18,951; £3,543.00 + (18,951 − 10,428.3333) = 8,522.6667 × 45% =
  // £3,835.20 → £7,378.20, floored.
  assert.equal(lastTax, "7378.2000");
});

// ---------------------------------------------------------------------------
// Threshold plumbing: published figures wire through per frequency
// ---------------------------------------------------------------------------

test("NIC thresholds are the published figures for 52/12/1, pro-rata otherwise", () => {
  assert.deepEqual(gbNicThresholdsForPeriod(52), { lel: "129", pt: "242", st: "96", uel: "967" });
  assert.deepEqual(gbNicThresholdsForPeriod(12), {
    lel: "559", pt: "1048", st: "417", uel: "4189",
  });
  assert.deepEqual(gbNicThresholdsForPeriod(1), {
    lel: "6708", pt: "12570", st: "5000", uel: "50270",
  });
  // Fortnightly PT: 12,570 / 26 = 483.4615… → £483.46 (half down).
  assert.equal(gbNicThresholdsForPeriod(26).pt, "483.4600");
});

test("tax month and week numbers follow HMRC's charts", () => {
  assert.equal(gbTaxMonthNumber("2026-04-06"), 1);
  assert.equal(gbTaxMonthNumber("2026-05-05"), 1);
  assert.equal(gbTaxMonthNumber("2026-05-06"), 2);
  assert.equal(gbTaxMonthNumber("2027-04-05"), 12);
  assert.equal(gbTaxWeekNumber("2026-04-06"), 1);
  assert.equal(gbTaxWeekNumber("2026-04-12"), 1);
  assert.equal(gbTaxWeekNumber("2026-04-13"), 2);
  assert.equal(gbTaxWeekNumber("2027-04-05"), 53);
});
