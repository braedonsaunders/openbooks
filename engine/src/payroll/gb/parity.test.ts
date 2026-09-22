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
  gbPeriodicBandTopUnits,
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
  assert.equal((code as { addedAnnual: string }).addedAnnual, "4750");
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

test("hand-worked: monthly £4,000 1257L month 3, no priors → £171.50", () => {
  // Free pay to date = 12,570 × 3/12 = £3,142.50. Cumulative pay £4,000.
  // Taxable = 4,000 − 3,142.50 = £857.50. 20% = £171.50. Nothing paid yet.
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
  assert.equal(result.tax, "171.5000");
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

test("hand-worked: full 2026/27 on £27,000 sums to £2,886.00", () => {
  // Twelve monthly £2,250 periods, cumulative 1257L. Each month deducts
  // £240.50 (free 1,047.50/2,095.00/..., taxable 1,202.50/2,405.00/...);
  // the year telescopes to the £14,430 × 20% golden above.
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
    if (index === 0) assert.equal(result.tax, "240.5000");
    assert.equal(result.tax, "240.5000", `month ${index + 1}`);
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 2250).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal((total / 10000n).toString(), "2886");
});

test("hand-worked: K code caps the period deduction at half of gross pay", () => {
  // K2000, month 12, £500 of pay, no priors: added to date £20,000,
  // cumulative taxable £20,500, liability £4,100 — capped at £250.
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

test("golden: pro-rated band tops match HMRC Tax Tables B-D Column 1", () => {
  // HMRC Taxable Pay Tables B-D ("Manual Method"), April 2023 edition: each
  // month/week row carries its own Column 1, the cumulative basic-rate limit
  // to date (p.4, English monthly: 3142, 6284, 9425 ... 37700; weekly: 725,
  // 1450 ... 37700). The annual bands there are £37,700/£125,140, frozen ever
  // since, so the rows pin the 2026/27 pro-rating method too. The month-2
  // figure discriminates the rounding: 37,700 × 2/12 = 6,283.33, and the
  // table prints 6,284 — ceiling, not round-half-up (which gives 6,283).
  assert.equal(gbPeriodicBandTopUnits("37700", 12, 1), 314_200_00n);
  assert.equal(gbPeriodicBandTopUnits("37700", 12, 2), 628_400_00n);
  assert.equal(gbPeriodicBandTopUnits("37700", 12, 12), 3_770_000_00n);
  assert.equal(gbPeriodicBandTopUnits("37700", 52, 1), 72_500_00n);
  assert.equal(gbPeriodicBandTopUnits("125140", 12, 1), 1_042_900_00n);
  assert.equal(gbPeriodicBandTopUnits("125140", 52, 1), 240_700_00n);
});

test("golden: 1257L £10,000 in month 1 withholds ~£2,952, not ~£1,790", () => {
  // The defect this pins: pricing a month-1 period through the ANNUAL bands
  // keeps all £8,952.50 (10,000 − 1,047.50) inside the £37,700 basic band and
  // withholds £1,790.50. HMRC prices month 1 through the month-1 Column 1
  // (£3,142 basic, £10,429 higher — see the test above): 3,142 × 20% =
  // £628.40 plus (8,952.50 − 3,142) = 5,810.50 × 40% = £2,324.20 → £2,952.60.
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
  assert.equal(result.tax, "2952.6000");
});

test("hand-worked: month-7 cumulative higher earner, £5,000 a month", () => {
  // Six £5,000 months behind, £5,000 in month 7: cumulative pay £35,000,
  // free pay to date 12,570 × 7/12 = £7,332.50, taxable £27,667.50. Month-7
  // Column 1 (ceiling(37,700 × 7/12) = 21,992 basic; ceiling(125,140 × 7/12)
  // = 72,999 higher): 21,992 × 20% = £4,398.40 plus (27,667.50 − 21,992) =
  // 5,675.50 × 40% = £2,270.20 → £6,668.60 cumulative; nothing paid yet.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2026-10-06",
    periodsPerYear: 12,
    periodPay: "5000",
    priorTaxablePay: "30000.0000",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "5000",
  });
  assert.equal(result.tax, "6668.6000");
});

test("hand-worked: weekly W1 £2,500 prices through week-1 bands", () => {
  // Period free 12,570/52 = £241.7307 (truncated at 1e-4); taxable
  // £2,258.2693. Week-1 Column 1: basic £725, higher ceiling(125,140/52) =
  // £2,407: 725 × 20% = £145.00 plus (2,258.2693 − 725) = 1,533.2693 × 40%
  // = £613.3077 → £613.31 → £758.31.
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
  assert.equal(result.tax, "758.3100");
});

test("hand-worked: full 2026/27 on £60,000 telescopes to £11,432.00", () => {
  // Twelve monthly £5,000 periods, cumulative 1257L: the year must telescope
  // to the annual liability on £47,430 (60,000 − 12,570): 37,700 × 20% =
  // £7,540 plus 9,730 × 40% = £3,892 → £11,432.00. Month 12 prices through
  // the annual bands exactly, so pro-rating changes the timing, never the
  // year total.
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
    if (index === 0) assert.equal(result.tax, "952.6000");
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 5000).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal(total, 1_143_200_00n);
});

test("hand-worked: non-cumulative K code prices added pay through month-1 bands", () => {
  // K475 M1 on £2,250: added pay 4,750/12 = £395.8333, taxable £2,645.8333,
  // inside the £3,142 month-1 basic band: × 20% = £529.1666 → £529.17. The
  // 50%-of-pay cap (£1,125) does not bind.
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
  assert.equal(result.tax, "529.1700");
  assert.equal(result.periodAddedPay, "395.8333");
});

test("hand-worked: W1 ignores year to date by definition", () => {
  // 1257L W1 on £2,250 with £9,999.99 already (wrongly) paid: period free
  // 1,047.50, taxable 1,202.50, due £240.50 — priors untouched.
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
  assert.equal(result.tax, "240.5000");
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
  // through MONTH-1 bands (Column 1: basic £3,142, higher £10,429):
  // £20,000 − £1,047.50 = £18,952.50 taxable: 3,142 × 20% = £628.40 plus
  // (10,429 − 3,142) = 7,287 × 40% = £2,914.80 plus (18,952.50 − 10,429) =
  // 8,523.50 × 45% = £3,835.575 → £3,835.57 (half down) → £7,378.77.
  assert.equal(lastTax, "7378.7700");
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
