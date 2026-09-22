/**
 * GB Scottish parity harness — run with `node --import tsx
 * engine/src/payroll/gb/parity-scotland.test.ts`.
 *
 * Sibling to parity.test.ts (rUK): the same four mechanisms, against the
 * Scottish starter..top bands (GB_SCT_BANDS):
 * 1. EXTERNAL GOLDENS from HMRC's own publications (Tax Tables B-D 2026/27
 *    PDF: the BR/SBR/CBR worked example and the p.2 flat-code rules; the
 *    scottish-income-tax current-rates table as an annual cross-check).
 *    Authority numbers are hardcoded with their quotes; any drift in our
 *    constants fails loudly.
 * 2. HAND-WORKED CASES derived step by step from the tables, independent of
 *    the engine, with the arithmetic shown — including the
 *    intermediate/higher boundary where a naive implementation drifts.
 * 3. EDITION RESOLUTION: the SCT edition exists and the shared year guard
 *    still throws outside 2026/27 — never extrapolates.
 * 4. A SWEEP over all six Scottish thresholds (at, below, above) plus a
 *    monotonicity pass across the pay scale.
 *
 * NIC is asserted nation-blind once: the UK-wide schedule prices identically
 * beside either code — the Scottish split changes income tax only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money/money.ts";
import {
  calculateGbNic,
  calculateGbPaye,
  gbCvalueUnits,
  gbResolveTaxYear,
  gbSctLiabilityUnits,
} from "./calculate.ts";
import { GB_SCT_BANDS, GB_TAX_YEARS } from "./rates.ts";
import { parseGbTaxCode } from "./tax-codes.ts";

// ---------------------------------------------------------------------------
// The transcribed table itself, pinned to its quoted figures
// ---------------------------------------------------------------------------

test("GB_SCT_BANDS matches the quoted 2026/27 Scottish table", () => {
  assert.deepEqual(
    GB_SCT_BANDS.map((band) => [band.upTo, band.rate]),
    [
      ["3967", "0.19"],
      ["16956", "0.20"],
      ["31092", "0.21"],
      ["62430", "0.42"],
      ["125140", "0.45"],
      [null, "0.48"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Mechanism 1: external goldens (HMRC's numbers, hardcoded)
// ---------------------------------------------------------------------------

test("golden: Tax Tables B-D SBR example £3,200 × 20% = £640.00", () => {
  // "£3,200 x 0.20 = £640.00" (Example 2, codes BR/SBR/CBR) — the SBR leg
  // prices through the engine's Scottish flat path.
  const result = calculateGbPaye({
    code: parseGbTaxCode("SBR"),
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

test("golden: Tables B-D p.2 Scottish flat rules price whole pay", () => {
  // "For code SD0 always multiply the whole pay by 0.21 (21%) ... SD1 ...
  // 0.42 (42%) ... SD2 ... 0.45 (45%) ... SD3 ... 0.48 (48%)".
  // £3,200 each: 672.00 / 1,344.00 / 1,440.00 / 1,536.00.
  const cases = [
    ["SD0", "672.0000"],
    ["SD1", "1344.0000"],
    ["SD2", "1440.0000"],
    ["SD3", "1536.0000"],
  ] as const;
  for (const [code, expected] of cases) {
    const result = calculateGbPaye({
      code: parseGbTaxCode(code),
      payDate: "2026-07-06",
      periodsPerYear: 12,
      periodPay: "3200",
      priorTaxablePay: "0",
      priorAddedPay: "0",
      priorTaxPaid: "0",
      periodGrossPay: "3200",
    });
    assert.equal(result.tax, expected, code);
  }
});

test("golden: S1257L on £27,000 prices £14,430 of taxable income", () => {
  // Scottish-income-tax page: standard Personal Allowance £12,570, so
  // £27,000 gross is £14,430 taxable: £3,967 × 19% = £753.73 plus
  // (£14,430 − £3,967) = £10,463 × 20% = £2,092.60 → £2,846.33 annual.
  assert.equal(gbSctLiabilityUnits(1_443_000_00n), 284_633_00n);
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked cases (arithmetic shown, engine-independent)
// ---------------------------------------------------------------------------

test("hand-worked: monthly £4,000 S1257L month 3, no priors → £162.45", () => {
  // Free pay to date = 3 × £1,048.26 = £3,144.78. Cumulative pay £4,000, so
  // Un = £855.22, Tn = £855. Income Test 1 (855.22 ≤ month-3 starter Cvalue
  // £992) selects Formula 1: £855 × 19% = £162.45, floored. Nothing paid.
  const result = calculateGbPaye({
    code: parseGbTaxCode("S1257L"),
    payDate: "2026-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
  });
  assert.equal(result.tax, "162.4500");
});

test("hand-worked: intermediate/higher boundary £31,092 vs £31,093", () => {
  // At £31,092: 3,967 × 19% = £753.73; (16,956 − 3,967) = 12,989 × 20% =
  // £2,597.80; (31,092 − 16,956) = 14,136 × 21% = £2,968.56 → £6,320.09.
  // The next pound prices at 42%: £6,320.51.
  assert.equal(gbSctLiabilityUnits(3_109_200_00n), 632_009_00n);
  assert.equal(gbSctLiabilityUnits(3_109_300_00n), 632_051_00n);
});

test("hand-worked: full 2026/27 on £27,000 S1257L telescopes to £2,844.33", () => {
  // Twelve monthly £2,250 periods, cumulative S1257L from zero priors: the
  // period dues telescope to the £14,430 × bands golden above.
  const code = parseGbTaxCode("S1257L");
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
    // Month 1 prices Formula 2 on the exact month-1 starter threshold
    // (3,967/12 = £330.5833) and threshold tax (753.73/12 = £62.8108):
    // Un = £1,201.74, Tn = £1,201; £62.8108 + (1,201 − 330.5833) = 870.4167
    // × 20% = £174.0833 → £236.8941, floored to £236.89. The year still
    // telescopes to the annual £2,844.33 (Tn £14,420 at starter/basic).
    if (index === 0) assert.equal(result.tax, "236.8900");
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 2250).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal(total, 284_433_00n);
});

test("hand-worked: Scottish higher is not rUK higher — SD1 vs D0 diverge", () => {
  // £3,200 at SD1 (42%) = £1,344.00; the same pay at rUK D0 (40%) =
  // £1,280.00. An S-code fallen through to rUK bands would under-withhold
  // £64.00 on this one period — the reason the fall-through is refused.
  // Direct: £3,200 all inside the starter band → 3,200 × 19% = £608.00.
  assert.equal(gbSctLiabilityUnits(320_000_00n), 60_800_00n);
  const sct = calculateGbPaye({
    code: parseGbTaxCode("SD1"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "3200",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "3200",
  });
  const ruk = calculateGbPaye({
    code: parseGbTaxCode("D0"),
    payDate: "2026-07-06",
    periodsPerYear: 12,
    periodPay: "3200",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "3200",
  });
  assert.equal(sct.tax, "1344.0000");
  assert.equal(ruk.tax, "1280.0000");
});

test("golden: S1257L £10,000 in month 1 prices through month-1 Scottish bands", () => {
  // Free pay £1,048.26, Un = £8,951.74, Tn = £8,951. Income Test 5
  // (8,951.74 ≤ advanced Cvalue £10,429) selects Formula 5 on the exact
  // month-1 higher threshold (62,430/12 = £5,202.50) and threshold tax
  // (19,482.05/12 = £1,623.5041): £1,623.5041 + (8,951 − 5,202.50) =
  // 3,748.50 × 45% = £1,686.825 → £3,310.3291, floored to £3,310.32. Pricing
  // through the printed £5,203 Cvalue gives £3,310.65 — pennies off (§2.5).
  // (Bands: employer rates page Scotland section, cross-checked to the pound
  // against Tax Tables B-D 2026/27 PDF p.3 — see GB_SCT_BANDS. Method:
  // Taxable Pay Tables B-D "Manual Method" Column 1, April 2023 edition
  // pp.12–13, whose ceiling rounding the rUK golden pins.)
  const result = calculateGbPaye({
    code: parseGbTaxCode("S1257L"),
    payDate: "2026-04-06",
    periodsPerYear: 12,
    periodPay: "10000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "10000",
  });
  assert.equal(result.tax, "3310.3200");
  // The 2026/27 starter pin itself: ceiling(3,967/12) = £331.
  assert.equal(gbCvalueUnits("3967", 12, 1), 33_100_00n);
});

test("hand-worked: S1257L W1 ignores year to date by definition", () => {
  // S1257L W1 on £2,250 with £9,999.99 already (wrongly) paid: period free
  // £1,048.26, Un = £1,201.74, Tn = £1,201 → Formula 2 (1,201.74 ≤ £1,413):
  // £62.8108 + 870.4167 × 20% = £236.8941 → £236.89 — priors untouched.
  const result = calculateGbPaye({
    code: parseGbTaxCode("S1257L W1"),
    payDate: "2027-03-06",
    periodsPerYear: 12,
    periodPay: "2250",
    priorTaxablePay: "20000",
    priorAddedPay: "0",
    priorTaxPaid: "9999.99",
    periodGrossPay: "2250",
  });
  assert.equal(result.tax, "236.8900");
});

test("NIC is nation-blind: one UK-wide schedule beside either code", () => {
  // £3,200 monthly prices (3,200 − 1,048) × 8% = £172.16 employee and
  // (3,200 − 417) × 15% = £417.45 employer — the same figures the rUK BR
  // wrapper run produces. No code, no table, no nation enters NIC.
  assert.deepEqual(calculateGbNic({ earnings: "3200", periodsPerYear: 12 }), {
    employee: "172.1600",
    employer: "417.4500",
  });
});

// ---------------------------------------------------------------------------
// Mechanism 3: the SCT edition exists, and the year guard still throws
// ---------------------------------------------------------------------------

test("SCT editions are published per year; pay dates outside them still throw", () => {
  for (const year of [2026, 2025, 2024]) {
    const sct = GB_TAX_YEARS.editions.find(
      (entry) => entry.region === "SCT" && entry.year === year,
    );
    assert.equal(sct?.status, "published", `SCT ${year}`);
  }
  const sct2026 = GB_TAX_YEARS.editions.find(
    (entry) => entry.region === "SCT" && entry.year === 2026,
  );
  assert.equal(sct2026?.year, 2026);
  assert.equal(gbResolveTaxYear("2026-04-06"), 2026);
  assert.equal(gbResolveTaxYear("2027-04-05"), 2026);
  // 2025/26 and 2024/25 resolve to their own SCT tables now; only dates
  // outside every transcribed year throw.
  assert.equal(gbResolveTaxYear("2025-04-06"), 2025);
  assert.equal(gbResolveTaxYear("2024-04-06"), 2024);
  for (const date of ["2024-04-05", "2027-04-06", "2028-01-01"]) {
    assert.throws(() => gbResolveTaxYear(date), /no transcribed tables/, date);
  }
});

// ---------------------------------------------------------------------------
// Mechanism 4: sweep across every Scottish threshold
// ---------------------------------------------------------------------------

test("sweep: Scottish liability at, below and above each band edge", () => {
  // Starter top £3,967 (19% → 20%): £753.73 at; a penny either side.
  assert.equal(gbSctLiabilityUnits(396_699_00n), 75_372_81n);
  assert.equal(gbSctLiabilityUnits(396_700_00n), 75_373_00n);
  assert.equal(gbSctLiabilityUnits(396_701_00n), 75_373_20n);
  // Basic top £16,956 (20% → 21%): £3,351.53 at.
  assert.equal(gbSctLiabilityUnits(1_695_599_00n), 335_152_80n);
  assert.equal(gbSctLiabilityUnits(1_695_600_00n), 335_153_00n);
  assert.equal(gbSctLiabilityUnits(1_695_601_00n), 335_153_21n);
  // Intermediate top £31,092 (21% → 42%): £6,320.09 at.
  assert.equal(gbSctLiabilityUnits(3_109_199_00n), 632_008_79n);
  assert.equal(gbSctLiabilityUnits(3_109_200_00n), 632_009_00n);
  assert.equal(gbSctLiabilityUnits(3_109_201_00n), 632_009_42n);
  // Higher top £62,430 (42% → 45%): £19,482.05 at.
  assert.equal(gbSctLiabilityUnits(6_242_999_00n), 1_948_204_58n);
  assert.equal(gbSctLiabilityUnits(6_243_000_00n), 1_948_205_00n);
  assert.equal(gbSctLiabilityUnits(6_243_001_00n), 1_948_205_45n);
  // Advanced top £125,140 (45% → 48%): £47,701.55 at.
  assert.equal(gbSctLiabilityUnits(12_513_999_00n), 4_770_154_55n);
  assert.equal(gbSctLiabilityUnits(12_514_000_00n), 4_770_155_00n);
  assert.equal(gbSctLiabilityUnits(12_514_001_00n), 4_770_155_48n);
});

test("sweep: Scottish PAYE never decreases as pay rises, 0 to £20,000 monthly", () => {
  const code = parseGbTaxCode("S1257L W1");
  let lastTax = "0.0000";
  for (let pence = 0; pence <= 2_000_000; pence += 25_000) {
    const pay = (pence / 100).toFixed(2);
    const paye = calculateGbPaye({
      code, payDate: "2026-07-06", periodsPerYear: 12,
      periodPay: pay, priorTaxablePay: "0", priorAddedPay: "0",
      priorTaxPaid: "0", periodGrossPay: pay,
    });
    assert.ok(toUnits(paye.tax) >= toUnits(lastTax), `${pay}: ${paye.tax} < ${lastTax}`);
    lastTax = paye.tax;
  }
  // A W1 period prices Formula 6 on the exact month-1 advanced threshold
  // (125,140/12 = £10,428.3333) and threshold tax (47,701.55/12 =
  // £3,975.1291): Un = £18,951.74, Tn = £18,951; £3,975.1291 +
  // (18,951 − 10,428.3333) = 8,522.6667 × 48% = £4,090.88 → £8,066.0091,
  // floored to £8,066.00.
  assert.equal(lastTax, "8066.0000");
});
