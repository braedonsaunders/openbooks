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
  gbPeriodicBandTopUnits,
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

test("hand-worked: monthly £4,000 S1257L month 3, no priors → £162.50", () => {
  // Free pay to date = 12,579 × 3/12 = £3,144.75 (the CODE's allowance).
  // Cumulative pay £4,000. Taxable = 4,000 − 3,144.75 = £855.25, all in the
  // 19% starter band (month-3 starter top £992): 855.25 × 19% = £162.4975
  // → £162.50. Nothing paid yet.
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
  assert.equal(result.tax, "162.5000");
});

test("hand-worked: intermediate/higher boundary £31,092 vs £31,093", () => {
  // At £31,092: 3,967 × 19% = £753.73; (16,956 − 3,967) = 12,989 × 20% =
  // £2,597.80; (31,092 − 16,956) = 14,136 × 21% = £2,968.56 → £6,320.09.
  // The next pound prices at 42%: £6,320.51.
  assert.equal(gbSctLiabilityUnits(3_109_200_00n), 632_009_00n);
  assert.equal(gbSctLiabilityUnits(3_109_300_00n), 632_051_00n);
});

test("hand-worked: full 2026/27 on £27,000 S1257L telescopes to £2,844.53", () => {
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
    // Month 1 prices through the month-1 Column 1 (starter £331, basic
    // £1,413): 331 × 19% = £62.89 plus (1,201.75 − 331) = 870.75 × 20% =
    // £174.15 → £237.04. The year still telescopes to the annual £2,844.53
    // (£14,421 at the Scottish starter/basic rates).
    if (index === 0) assert.equal(result.tax, "237.0400");
    total += BigInt(result.tax.replace(".", ""));
    priorTaxable = `${(Number(priorTaxable) + 2250).toFixed(4)}`;
    priorPaid = `${(Number(priorPaid) + Number(result.tax)).toFixed(4)}`;
  });
  assert.equal((total / 10000n).toString(), "2844");
  assert.equal(Number(total % 10000n), 5300);
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
  // Free pay 1,048.25, taxable £8,951.75. Month-1 Column 1 (ceiling of each
  // 2026/27 Scottish band / 12: starter £331, basic £1,413, intermediate
  // £2,591, higher £5,203, advanced £10,429 — the starter pin is asserted
  // below): 331 × 19% = £62.89 plus 1,082 × 20% = £216.40 plus 1,178 × 21% =
  // £247.38 plus 2,612 × 42% = £1,097.04 plus (8,951.75 − 5,203) = 3,748.75
  // × 45% = £1,686.9375 → £1,686.94 → £3,310.65.
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
  assert.equal(result.tax, "3310.6500");
  // The 2026/27 starter pin itself: ceiling(3,967/12) = £331.
  assert.equal(gbPeriodicBandTopUnits("3967", 12, 1), 33_100_00n);
});

test("hand-worked: S1257L W1 ignores year to date by definition", () => {
  // S1257L W1 on £2,250 with £9,999.99 already (wrongly) paid: period free
  // 1,048.25, taxable 1,201.75, through the MONTH-1 bands (starter £331,
  // basic £1,413): 331 × 19% = £62.89 plus 870.75 × 20% = £174.15 →
  // £237.04 — priors untouched.
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
  assert.equal(result.tax, "237.0400");
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
  // A W1 period prices through the MONTH-1 bands (starter £331, basic
  // £1,413, intermediate £2,591, higher £5,203, advanced £10,429):
  // £20,000 − £1,048.25 = £18,951.75 taxable: 331 × 19% = £62.89 plus
  // 1,082 × 20% = £216.40 plus 1,178 × 21% = £247.38 plus 2,612 × 42% =
  // £1,097.04 plus (10,429 − 5,203) = 5,226 × 45% = £2,351.70 plus
  // (18,951.75 − 10,429) = 8,522.75 × 48% = £4,090.92 → £8,066.33.
  assert.equal(lastTax, "8066.3300");
});
