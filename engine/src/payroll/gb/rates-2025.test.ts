/**
 * GB 2025/26 conformance — run with `node --import tsx
 * engine/src/payroll/gb/rates-2025.test.ts`.
 *
 * Every figure is transcribed from HMRC's own 2025 to 2026 publications
 * (see rates-2025.ts); the goldens below are hand-worked from those tables,
 * independently of the engine, with the arithmetic shown. Three mechanisms:
 *
 * 1. TRANSCRIPTION PINS: each constant asserted against its quoted source
 *    figure — any drift in the transcription fails loudly.
 * 2. HAND-WORKED CASES: PAYE/NIC liabilities derived step by step from the
 *    published thresholds and rates, including the cases that DISCRIMINATE
 *    2025/26 from its neighbours (the 15% employer rate against 2024/25's
 *    13.8%; the 2025/26 Scottish starter/basic tops against both neighbours).
 * 3. EDITION RESOLUTION: the year resolves from its dates and refuses
 *    outside them; both scopes (main and SCT) are published.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateGbNic,
  calculateGbPaye,
  gbResolveTaxYear,
  gbRukLiabilityUnits,
  gbSctLiabilityUnits,
  gbTaxMonthNumber,
  gbTaxWeekNumber,
  resolveGbCumulativeBasis,
} from "./calculate.ts";
import { parseGbTaxCode } from "./tax-codes.ts";
import {
  GB_2025_AE_QUALIFYING_BAND_LOWER,
  GB_2025_AE_QUALIFYING_BAND_UPPER,
  GB_2025_AE_TRIGGER_ANNUAL,
  GB_2025_EMPLOYMENT_ALLOWANCE_ANNUAL,
  GB_2025_MONTH_ONE_END,
  GB_2025_NIC_ANNUAL,
  GB_2025_NIC_EMPLOYEE_MAIN_RATE,
  GB_2025_NIC_EMPLOYEE_UPPER_RATE,
  GB_2025_NIC_EMPLOYER_RATE,
  GB_2025_NIC_MONTHLY,
  GB_2025_NIC_WEEKLY,
  GB_2025_PERSONAL_ALLOWANCE_ANNUAL,
  GB_2025_PERSONAL_ALLOWANCE_ZERO_AT,
  GB_2025_RUK_BANDS,
  GB_2025_SCT_BANDS,
  GB_2025_TAPER_START,
  GB_2025_TAX_YEAR_END,
  GB_2025_TAX_YEAR_START,
} from "./rates-2025.ts";
import { GB_TAX_YEARS } from "./rates.ts";
import { unfilledPaths } from "../unfilled.ts";
import { GB_2025_TABLES } from "./year-tables.ts";

// ---------------------------------------------------------------------------
// Mechanism 3 first: the edition must be transcribed before it is published
// ---------------------------------------------------------------------------

test("2025/26 tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(GB_2025_TABLES);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2025 figure from the 2025 to 2026 employer rates page — still unfilled: "
    + unfilled.join(", "),
  );
  const main = GB_TAX_YEARS.editions.find(
    (edition) => edition.year === 2025 && edition.region == null,
  );
  const sct = GB_TAX_YEARS.editions.find(
    (edition) => edition.year === 2025 && edition.region === "SCT",
  );
  assert.equal(main?.status, "published");
  assert.equal(main?.effectiveFrom, "2025-04-06");
  assert.match(main?.citation ?? "", /rates-and-thresholds-for-employers-2025-to-2026/);
  // Scotland is a separate edition, not a column: the SCT scope publishes
  // alongside the main one, with its own citation.
  assert.equal(sct?.status, "published");
  assert.equal(sct?.effectiveFrom, "2025-04-06");
  assert.match(sct?.citation ?? "", /scottish-income-tax/);
});

// ---------------------------------------------------------------------------
// Mechanism 1: transcription pins
// ---------------------------------------------------------------------------

test("2025/26 year bounds and Personal Allowance", () => {
  assert.equal(GB_2025_TAX_YEAR_START, "2025-04-06");
  assert.equal(GB_2025_TAX_YEAR_END, "2026-04-05");
  assert.equal(GB_2025_MONTH_ONE_END, "2025-05-05");
  // Employer rates page, England/NI AND Wales AND Scotland sections alike:
  // "The standard employee personal allowance for the 2025 to 2026 tax year
  // is: £242 per week £1,048 per month £12,570 per year".
  assert.equal(GB_2025_PERSONAL_ALLOWANCE_ANNUAL, "12570");
  // Taper (income-tax-rates, June 2025 snapshot): "goes down by £1 for every
  // £2 ... above £100,000 ... zero if your income is £125,140 or above".
  // Documented — the engine reads the code HMRC issued, never the taper.
  assert.equal(GB_2025_TAPER_START, "100000");
  assert.equal(GB_2025_PERSONAL_ALLOWANCE_ZERO_AT, "125140");
});

test("2025/26 rUK bands are the frozen 20/40/45", () => {
  // Employer rates page: "Basic tax rate 20% Up to £37,700", "Higher tax
  // rate 40% From £37,701 to £125,140", "Additional tax rate 45% Above
  // £125,140" — identical under England/NI and Wales.
  assert.deepEqual([...GB_2025_RUK_BANDS], [
    { upTo: "37700", rate: "0.20" },
    { upTo: "125140", rate: "0.40" },
    { upTo: null, rate: "0.45" },
  ]);
});

test("2025/26 Scottish bands are their own six-band table", () => {
  // Employer rates page, Scotland section: "Starter tax rate 19% Up to
  // £2,827", "Basic tax rate 20% From £2,828 to £14,921", "Intermediate tax
  // rate 21% From £14,922 to £31,092", "Higher tax rate 42% From £31,093 to
  // £62,430", "Advanced tax rate 45% From £62,431 to £125,140", "Top tax
  // rate 48% Above £125,140". Neither neighbour's starter/basic tops match:
  // 2024/25 prints £2,306/£13,991, 2026/27 prints £3,967/£16,956.
  assert.deepEqual([...GB_2025_SCT_BANDS], [
    { upTo: "2827", rate: "0.19" },
    { upTo: "14921", rate: "0.20" },
    { upTo: "31092", rate: "0.21" },
    { upTo: "62430", rate: "0.42" },
    { upTo: "125140", rate: "0.45" },
    { upTo: null, rate: "0.48" },
  ]);
  // Gross-space cross-check (scottish-income-tax, 2025 to 2026 table):
  // "£12,571 to £15,397 19%", "£15,398 to £27,491 20%", "£27,492 to £43,662
  // 21%", "£43,663 to £75,000 42%" — each top exactly £12,570 above the
  // taxable-space top (15,397 = 12,570 + 2,827; 27,491 = 12,570 + 14,921;
  // 43,662 = 12,570 + 31,092; 75,000 = 12,570 + 62,430).
  const grossTops = [15397, 27491, 43662, 75000];
  GB_2025_SCT_BANDS.slice(0, 4).forEach((band, index) => {
    assert.equal(Number(band.upTo) + 12570, grossTops[index], `SCT band ${index}`);
  });
});

test("2025/26 NIC thresholds are HMRC's published roundings", () => {
  // Employer rates page: "Lower earnings limit £125 per week £542 per month
  // £6,500 per year", "Primary threshold £242 per week £1,048 per month
  // £12,570 per year", "Secondary threshold £96 per week £417 per month
  // £5,000 per year", "Upper earnings limit £967 per week £4,189 per month
  // £50,270 per year".
  assert.deepEqual({ ...GB_2025_NIC_ANNUAL }, { lel: "6500", pt: "12570", st: "5000", uel: "50270" });
  assert.deepEqual({ ...GB_2025_NIC_WEEKLY }, { lel: "125", pt: "242", st: "96", uel: "967" });
  assert.deepEqual({ ...GB_2025_NIC_MONTHLY }, { lel: "542", pt: "1048", st: "417", uel: "4189" });
  // Published, never pro-rated: £12,570 ÷ 52 = £241.73, but the engine
  // prices the published £242; £5,000 ÷ 12 = £416.67, but the engine prices
  // the published £417.
  assert.equal(GB_2025_NIC_WEEKLY.pt, "242");
  assert.equal(GB_2025_NIC_MONTHLY.st, "417");
});

test("2025/26 NIC rates: employee 8%/2%, employer 15%", () => {
  // Employer rates page, category letter A: employee "0%", "8%", "2%";
  // employer "15%" in every column above the secondary threshold — the
  // Autumn Budget 2024 rise (13.8% → 15%) and ST cut (£9,100 → £5,000),
  // effective 6 April 2025, i.e. the year boundary, not mid-year.
  assert.equal(GB_2025_NIC_EMPLOYEE_MAIN_RATE, "0.08");
  assert.equal(GB_2025_NIC_EMPLOYEE_UPPER_RATE, "0.02");
  assert.equal(GB_2025_NIC_EMPLOYER_RATE, "0.15");
});

test("2025/26 Employment Allowance and auto-enrolment band (declared, no engine)", () => {
  // Employer rates page: "Employment Allowance ... £10,500" for 2025 to
  // 2026 (raised from £5,000, £100k cap removed — Autumn Budget 2024).
  assert.equal(GB_2025_EMPLOYMENT_ALLOWANCE_ANNUAL, "10500");
  // DWP 2025/26 supporting analysis, Table 1: trigger £10,000, lower
  // qualifying band £6,240, upper £50,270 (current and proposed identical).
  assert.equal(GB_2025_AE_TRIGGER_ANNUAL, "10000");
  assert.equal(GB_2025_AE_QUALIFYING_BAND_LOWER, "6240");
  assert.equal(GB_2025_AE_QUALIFYING_BAND_UPPER, "50270");
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked cases (arithmetic shown, engine-independent)
// ---------------------------------------------------------------------------

test("2025/26 rUK: 1257L on £27,000 prices £14,430 at 20% = £2,886.00", () => {
  // Taxable £14,430 sits wholly in the basic band: 14,430 × 20% = £2,886.00.
  assert.equal(gbRukLiabilityUnits(1_443_000_00n, GB_2025_TABLES), 288_600_00n);
});

test("2025/26 rUK: K475 on £27,000 prices £31,750 = £6,350.00", () => {
  // Letters page: K475 adds £4,750 (number × 10) to £27,000 of pay. 31,750
  // × 20% = £6,350.00 — still wholly basic, as in both neighbours.
  const code = parseGbTaxCode("K475");
  assert.equal(code.kind, "k");
  assert.equal(gbRukLiabilityUnits(3_175_000_00n, GB_2025_TABLES), 635_000_00n);
});

test("2025/26 Scotland: S1257L on £27,000 prices £14,430 = £2,857.73", () => {
  // Starter: 2,827 × 19% = £537.13 (2,827 × 19 = 53,713). Basic remainder:
  // (14,430 − 2,827) = 11,603 × 20% = £2,320.60. Total £2,857.73 — neither
  // neighbour agrees (2024/25: £2,862.94; 2026/27: £2,846.33).
  assert.equal(gbSctLiabilityUnits(1_443_000_00n, GB_2025_TABLES), 28_577_300n);
});

test("2025/26 Scotland: S1257L on £60,000 prices £47,430 = £13,213.80", () => {
  // Starter 2,827 × 19% = £537.13; basic (14,921 − 2,827) = 12,094 × 20% =
  // £2,418.80; intermediate (31,092 − 14,921) = 16,171 × 21% = £3,395.91
  // (16,171 × 21 = 339,591); higher (47,430 − 31,092) = 16,338 × 42% =
  // £6,861.96 (16,338 × 42 = 686,196). Total £13,213.80.
  assert.equal(gbSctLiabilityUnits(4_743_000_00n, GB_2025_TABLES), 132_138_000n);
});

test("2025/26 NIC: monthly £4,000 pays £236.16 employee, £537.45 employer", () => {
  // Employee: (4,000 − 1,048) = 2,952 × 8% = £236.16. Employer at the new
  // 15% rate: (4,000 − 417) = 3,583 × 15% = £537.45 (3,583 × 15 = 53,745).
  const result = calculateGbNic({ earnings: "4000", periodsPerYear: 12, tables: GB_2025_TABLES });
  assert.equal(result.employee, "236.1600");
  assert.equal(result.employer, "537.4500");
});

test("2025/26 NIC: weekly £300 pays £4.64 employee, £30.60 employer", () => {
  // Employee: (300 − 242) = 58 × 8% = £4.64. Employer: (300 − 96) = 204 ×
  // 15% = £30.60.
  const result = calculateGbNic({ earnings: "300", periodsPerYear: 52, tables: GB_2025_TABLES });
  assert.equal(result.employee, "4.6400");
  assert.equal(result.employer, "30.6000");
});

test("2025/26 NIC: weekly £2,300 pays £84.66 employee, £330.60 employer", () => {
  // Employee: (967 − 242) = 725 × 8% = £58.00; (2,300 − 967) = 1,333 × 2% =
  // £26.66; total £84.66. Employer: (2,300 − 96) = 2,204 × 15% = £330.60
  // (2,204 × 15 = 33,060).
  const result = calculateGbNic({ earnings: "2300", periodsPerYear: 52, tables: GB_2025_TABLES });
  assert.equal(result.employee, "84.6600");
  assert.equal(result.employer, "330.6000");
});

test("2025/26 PAYE: monthly £4,000 1257L month 3, no priors → £171.50", () => {
  // Free pay to date = 12,570 × 3/12 = £3,142.50. Taxable = 4,000 −
  // 3,142.50 = £857.50. 20% = £171.50. Nothing paid yet.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2025-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2025_TABLES,
  });
  assert.equal(result.tax, "171.5000");
});

test("2025/26 PAYE: monthly £4,000 S1257L month 3 → £162.92 (half down)", () => {
  // Taxable £857.50 sits wholly in the starter band: 857.50 × 19% =
  // £162.925 — an exact half-penny, which Regulation 12(1) disregards, so
  // £162.92, not £162.93.
  const result = calculateGbPaye({
    code: parseGbTaxCode("S1257L"),
    payDate: "2025-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2025_TABLES,
  });
  assert.equal(result.tax, "162.9200");
});

test("2025/26: C1257L prices exactly as 1257L — Wales needs no edition", () => {
  // Welsh-income-tax, Rates and bands for 2025 to 2026: "These rates have
  // been set by the Welsh Government" over a table identical to rUK.
  const welsh = calculateGbPaye({
    code: parseGbTaxCode("C1257L"),
    payDate: "2025-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2025_TABLES,
  });
  assert.equal(welsh.tax, "171.5000");
});

test("2025/26: BR £3,200 × 20% = £640.00; 1257L X is period-only", () => {
  // Flat BR arithmetic is year-independent; the pay date puts it in 2025/26.
  const br = calculateGbPaye({
    code: parseGbTaxCode("BR"),
    payDate: "2025-07-06",
    periodsPerYear: 12,
    periodPay: "3200",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "3200",
    tables: GB_2025_TABLES,
  });
  assert.equal(br.tax, "640.0000");
  // P9X(2025): "The emergency code is 1257L for all employees"; the employer
  // rates page lists the operated markers 1257L W1 / M1 / X from 6 April
  // 2025 — the X marker prices the period alone.
  assert.equal(parseGbTaxCode("1257L X").kind, "suffix");
  assert.equal((parseGbTaxCode("1257L X") as { nonCumulative: boolean }).nonCumulative, true);
});

// ---------------------------------------------------------------------------
// Mechanism 3 (continued): resolution, weeks, sweeps, basis gate
// ---------------------------------------------------------------------------

test("2025/26 resolves from its dates and refuses outside them", () => {
  assert.equal(gbResolveTaxYear("2025-04-06"), 2025);
  assert.equal(gbResolveTaxYear("2025-09-20"), 2025);
  assert.equal(gbResolveTaxYear("2026-04-05"), 2025);
  // 2025-03-20 falls in 2024/25 (fiscal, not calendar); 2024-04-05 falls in
  // 2023/24, which has no transcribed tables and is refused, not priced.
  assert.equal(gbResolveTaxYear("2025-03-20"), 2024);
  assert.throws(() => gbResolveTaxYear("2024-04-05"), /no transcribed tables for pay date 2024-04-05/);
  assert.equal(gbTaxMonthNumber("2025-04-06"), 1);
  assert.equal(gbTaxMonthNumber("2026-04-05"), 12);
  assert.equal(gbTaxWeekNumber("2025-04-06", "2025-04-06"), 1);
  assert.equal(gbTaxWeekNumber("2025-04-12", "2025-04-06"), 1);
  assert.equal(gbTaxWeekNumber("2025-04-13", "2025-04-06"), 2);
});

test("2025/26 band-boundary sweep (at, below, above) plus monotonicity", () => {
  // Starter/basic join: the 2,828th pound prices at 20%, not 19%.
  assert.equal(gbSctLiabilityUnits(282_700_00n, GB_2025_TABLES), 5_371_300n);
  assert.equal(
    gbSctLiabilityUnits(282_800_00n, GB_2025_TABLES) - gbSctLiabilityUnits(282_700_00n, GB_2025_TABLES),
    2_000n,
  );
  // Top band: the 125,141st pound prices at 48%.
  assert.equal(
    gbSctLiabilityUnits(12_514_100_00n, GB_2025_TABLES) - gbSctLiabilityUnits(12_514_000_00n, GB_2025_TABLES),
    4_800n,
  );
  // rUK basic/higher join at £37,700: the next pound prices at 40%.
  assert.equal(gbRukLiabilityUnits(3_770_000_00n, GB_2025_TABLES), 75_400_000n);
  assert.equal(
    gbRukLiabilityUnits(3_770_100_00n, GB_2025_TABLES) - gbRukLiabilityUnits(3_770_000_00n, GB_2025_TABLES),
    4_000n,
  );
  let previous = 0n;
  for (let pay = 0; pay <= 2_000_000_000; pay += 500_000) {
    const liability = gbSctLiabilityUnits(BigInt(pay), GB_2025_TABLES);
    assert.ok(liability >= previous, `monotone at ${pay}`);
    previous = liability;
  }
});

test("2025/26 cumulative basis gate follows the 2025 month-one end", () => {
  // Month 1 is complete by definition; after it, the gate still refuses the
  // gapped cases by name.
  resolveGbCumulativeBasis({
    payDate: "2025-04-20",
    starterDeclaration: null,
    hasStubs: false,
    minStubPayDate: null,
    monthOneEnd: GB_2025_MONTH_ONE_END,
  });
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2025-06-06",
      starterDeclaration: null,
      hasStubs: false,
      minStubPayDate: null,
      monthOneEnd: GB_2025_MONTH_ONE_END,
    }),
    /complete in-year record/,
  );
});
