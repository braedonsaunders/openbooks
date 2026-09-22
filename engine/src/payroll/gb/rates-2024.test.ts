/**
 * GB 2024/25 conformance — run with `node --import tsx
 * engine/src/payroll/gb/rates-2024.test.ts`.
 *
 * Every figure is transcribed from HMRC's own 2024 to 2025 publications
 * (see rates-2024.ts); the goldens below are hand-worked from those tables,
 * independently of the engine, with the arithmetic shown. Three mechanisms:
 *
 * 1. TRANSCRIPTION PINS: each constant asserted against its quoted source
 *    figure — any drift in the transcription fails loudly.
 * 2. HAND-WORKED CASES: PAYE/NIC liabilities derived step by step from the
 *    published thresholds and rates, including the cases that DISCRIMINATE
 *    2024/25 from its neighbours (the 13.8% employer rate and £9,100
 *    secondary threshold against 2025/26's 15% and £5,000; the 2024/25
 *    Scottish starter/basic tops against both neighbours).
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
  GB_2024_AE_QUALIFYING_BAND_LOWER,
  GB_2024_AE_QUALIFYING_BAND_UPPER,
  GB_2024_AE_TRIGGER_ANNUAL,
  GB_2024_EMPLOYMENT_ALLOWANCE_ANNUAL,
  GB_2024_MONTH_ONE_END,
  GB_2024_NIC_ANNUAL,
  GB_2024_NIC_EMPLOYEE_MAIN_RATE,
  GB_2024_NIC_EMPLOYEE_UPPER_RATE,
  GB_2024_NIC_EMPLOYER_RATE,
  GB_2024_NIC_MONTHLY,
  GB_2024_NIC_WEEKLY,
  GB_2024_PERSONAL_ALLOWANCE_ANNUAL,
  GB_2024_PERSONAL_ALLOWANCE_ZERO_AT,
  GB_2024_RUK_BANDS,
  GB_2024_SCT_BANDS,
  GB_2024_TAPER_START,
  GB_2024_TAX_YEAR_END,
  GB_2024_TAX_YEAR_START,
} from "./rates-2024.ts";
import { GB_TAX_YEARS } from "./rates.ts";
import { unfilledPaths } from "../unfilled.ts";
import { GB_2024_TABLES } from "./year-tables.ts";

// ---------------------------------------------------------------------------
// Mechanism 3 first: the edition must be transcribed before it is published
// ---------------------------------------------------------------------------

test("2024/25 tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(GB_2024_TABLES);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2024 figure from the 2024 to 2025 employer rates page — still unfilled: "
    + unfilled.join(", "),
  );
  const main = GB_TAX_YEARS.editions.find(
    (edition) => edition.year === 2024 && edition.region == null,
  );
  const sct = GB_TAX_YEARS.editions.find(
    (edition) => edition.year === 2024 && edition.region === "SCT",
  );
  assert.equal(main?.status, "published");
  assert.equal(main?.effectiveFrom, "2024-04-06");
  assert.match(main?.citation ?? "", /rates-and-thresholds-for-employers-2024-to-2025/);
  // Scotland is a separate edition, not a column: the SCT scope publishes
  // alongside the main one, with its own citation.
  assert.equal(sct?.status, "published");
  assert.equal(sct?.effectiveFrom, "2024-04-06");
  assert.match(sct?.citation ?? "", /scottish-income-tax/);
});

// ---------------------------------------------------------------------------
// Mechanism 1: transcription pins
// ---------------------------------------------------------------------------

test("2024/25 year bounds and Personal Allowance", () => {
  assert.equal(GB_2024_TAX_YEAR_START, "2024-04-06");
  assert.equal(GB_2024_TAX_YEAR_END, "2025-04-05");
  assert.equal(GB_2024_MONTH_ONE_END, "2024-05-05");
  // Employer rates page, England/NI AND Wales AND Scotland sections alike:
  // "The standard employee personal allowance for the 2024 to 2025 tax year
  // is: £242 per week £1,048 per month £12,570 per year".
  assert.equal(GB_2024_PERSONAL_ALLOWANCE_ANNUAL, "12570");
  // Taper (income-tax-rates, September 2024 snapshot): the allowance is
  // "smaller if your income is over £100,000" and "You do not get a Personal
  // Allowance on taxable income over £125,140". Documented — the engine
  // reads the code HMRC issued, never the taper.
  assert.equal(GB_2024_TAPER_START, "100000");
  assert.equal(GB_2024_PERSONAL_ALLOWANCE_ZERO_AT, "125140");
});

test("2024/25 rUK bands are the frozen 20/40/45", () => {
  // Employer rates page: "Basic tax rate 20% Up to £37,700", "Higher tax
  // rate 40% From £37,701 to £125,140", "Additional tax rate 45% Above
  // £125,140" — identical under England/NI and Wales.
  assert.deepEqual([...GB_2024_RUK_BANDS], [
    { upTo: "37700", rate: "0.20" },
    { upTo: "125140", rate: "0.40" },
    { upTo: null, rate: "0.45" },
  ]);
});

test("2024/25 Scottish bands are their own six-band table", () => {
  // Employer rates page, Scotland section: "Starter tax rate 19% Up to
  // £2,306", "Basic tax rate 20% From £2,307 to £13,991", "Intermediate tax
  // rate 21% From £13,992 to £31,092", "Higher tax rate 42% From £31,093 to
  // £62,430", "Advanced tax rate 45% From £62,431 to £125,140", "Top tax
  // rate 48% Above £125,140". Neither neighbour's starter/basic tops match:
  // 2025/26 prints £2,827/£14,921, 2026/27 prints £3,967/£16,956.
  assert.deepEqual([...GB_2024_SCT_BANDS], [
    { upTo: "2306", rate: "0.19" },
    { upTo: "13991", rate: "0.20" },
    { upTo: "31092", rate: "0.21" },
    { upTo: "62430", rate: "0.42" },
    { upTo: "125140", rate: "0.45" },
    { upTo: null, rate: "0.48" },
  ]);
  // Gross-space cross-check (scottish-income-tax, 2024 to 2025 table):
  // "£12,571 to £14,876 19%", "£14,877 to £26,561 20%", "£26,562 to £43,662
  // 21%", "£43,663 to £75,000 42%" — each top exactly £12,570 above the
  // taxable-space top (14,876 = 12,570 + 2,306; 26,561 = 12,570 + 13,991;
  // 43,662 = 12,570 + 31,092; 75,000 = 12,570 + 62,430).
  const grossTops = [14876, 26561, 43662, 75000];
  GB_2024_SCT_BANDS.slice(0, 4).forEach((band, index) => {
    assert.equal(Number(band.upTo) + 12570, grossTops[index], `SCT band ${index}`);
  });
});

test("2024/25 NIC thresholds are HMRC's published roundings", () => {
  // Employer rates page: "Lower earnings limit £123 per week £533 per month
  // £6,396 per year", "Primary threshold £242 per week £1,048 per month
  // £12,570 per year", "Secondary threshold £175 per week £758 per month
  // £9,100 per year", "Upper earnings limit £967 per week £4,189 per month
  // £50,270 per year".
  assert.deepEqual({ ...GB_2024_NIC_ANNUAL }, { lel: "6396", pt: "12570", st: "9100", uel: "50270" });
  assert.deepEqual({ ...GB_2024_NIC_WEEKLY }, { lel: "123", pt: "242", st: "175", uel: "967" });
  assert.deepEqual({ ...GB_2024_NIC_MONTHLY }, { lel: "533", pt: "1048", st: "758", uel: "4189" });
  // Published, never pro-rated: £9,100 ÷ 12 = £758.33, but the engine
  // prices the published £758; £12,570 ÷ 52 = £241.73, but the engine prices
  // the published £242.
  assert.equal(GB_2024_NIC_MONTHLY.st, "758");
  assert.equal(GB_2024_NIC_WEEKLY.pt, "242");
});

test("2024/25 NIC rates: employee 8%/2%, employer 13.8%", () => {
  // Employer rates page, category letter A: employee "0%", "8%", "2%";
  // employer "0%" to ST then "13.8%" above it — the pre-Budget rate, before
  // the 6 April 2025 rise to 15%.
  assert.equal(GB_2024_NIC_EMPLOYEE_MAIN_RATE, "0.08");
  assert.equal(GB_2024_NIC_EMPLOYEE_UPPER_RATE, "0.02");
  assert.equal(GB_2024_NIC_EMPLOYER_RATE, "0.138");
});

test("2024/25 Employment Allowance and auto-enrolment band (declared, no engine)", () => {
  // Employer rates page: "Employment Allowance ... £5,000" for 2024 to
  // 2025 — the last year of the £5,000 cap (raised to £10,500 from 2025/26).
  assert.equal(GB_2024_EMPLOYMENT_ALLOWANCE_ANNUAL, "5000");
  // DWP 2024/25 supporting analysis: trigger £10,000 maintained for 2024 to
  // 2025, lower qualifying band £6,240, upper £50,270.
  assert.equal(GB_2024_AE_TRIGGER_ANNUAL, "10000");
  assert.equal(GB_2024_AE_QUALIFYING_BAND_LOWER, "6240");
  assert.equal(GB_2024_AE_QUALIFYING_BAND_UPPER, "50270");
});

// ---------------------------------------------------------------------------
// Mechanism 2: hand-worked cases (arithmetic shown, engine-independent)
// ---------------------------------------------------------------------------

test("2024/25 rUK: 1257L on £27,000 prices £14,430 at 20% = £2,886.00", () => {
  // Taxable £14,430 sits wholly in the basic band: 14,430 × 20% = £2,886.00.
  assert.equal(gbRukLiabilityUnits(1_443_000_00n, GB_2024_TABLES), 288_600_00n);
});

test("2024/25 rUK: K475 on £27,000 prices £31,750 = £6,350.00", () => {
  // Letters page: K475 adds £4,750 (number × 10) to £27,000 of pay. 31,750
  // × 20% = £6,350.00 — still wholly basic, as in both neighbours.
  const code = parseGbTaxCode("K475");
  assert.equal(code.kind, "k");
  assert.equal(gbRukLiabilityUnits(3_175_000_00n, GB_2024_TABLES), 635_000_00n);
});

test("2024/25 Scotland: S1257L on £27,000 prices £14,430 = £2,867.33", () => {
  // Starter: 2,306 × 19% = £438.14 (2,306 × 19 = 43,814). Basic in full:
  // (13,991 − 2,306) = 11,685 × 20% = £2,337.00 — £14,430 overshoots the
  // £13,991 basic top, so (14,430 − 13,991) = 439 spills into intermediate
  // at 21%: 439 × 21 = 9,219 → £92.19. Total £2,867.33 — neither neighbour
  // agrees (2025/26: £2,857.73; 2026/27: £2,846.33).
  assert.equal(gbSctLiabilityUnits(1_443_000_00n, GB_2024_TABLES), 28_673_300n);
});

test("2024/25 Scotland: S1257L on £60,000 prices £47,430 = £13,228.31", () => {
  // Starter 2,306 × 19% = £438.14; basic (13,991 − 2,306) = 11,685 × 20% =
  // £2,337.00; intermediate (31,092 − 13,991) = 17,101 × 21% = £3,591.21
  // (17,101 × 21 = 359,121); higher (47,430 − 31,092) = 16,338 × 42% =
  // £6,861.96 (16,338 × 42 = 686,196). Total £13,228.31.
  assert.equal(gbSctLiabilityUnits(4_743_000_00n, GB_2024_TABLES), 132_283_100n);
});

test("2024/25 NIC: monthly £4,000 pays £236.16 employee, £447.40 employer", () => {
  // Employee: (4,000 − 1,048) = 2,952 × 8% = £236.16. Employer at the
  // pre-rise 13.8%: (4,000 − 758) = 3,242 × 13.8% = £447.396 (3,242 × 138 =
  // 447,396) — the third decimal rounds the penny UP to £447.40.
  const result = calculateGbNic({ earnings: "4000", periodsPerYear: 12, tables: GB_2024_TABLES });
  assert.equal(result.employee, "236.1600");
  assert.equal(result.employer, "447.4000");
});

test("2024/25 NIC: weekly £300 pays £4.64 employee, £17.25 employer", () => {
  // Employee: (300 − 242) = 58 × 8% = £4.64. Employer: (300 − 175) = 125 ×
  // 13.8% = £17.25 exactly.
  const result = calculateGbNic({ earnings: "300", periodsPerYear: 52, tables: GB_2024_TABLES });
  assert.equal(result.employee, "4.6400");
  assert.equal(result.employer, "17.2500");
});

test("2024/25 NIC: weekly £2,300 pays £84.66 employee, £293.25 employer", () => {
  // Employee: (967 − 242) = 725 × 8% = £58.00; (2,300 − 967) = 1,333 × 2% =
  // £26.66; total £84.66. Employer: (2,300 − 175) = 2,125 × 13.8% =
  // £293.25 (2,125 × 138 = 293,250).
  const result = calculateGbNic({ earnings: "2300", periodsPerYear: 52, tables: GB_2024_TABLES });
  assert.equal(result.employee, "84.6600");
  assert.equal(result.employer, "293.2500");
});

test("2024/25 PAYE: monthly £4,000 1257L month 3, no priors → £171.05", () => {
  // Free pay to date = 12,579 × 3/12 = £3,144.75 (the code's allowance,
  // shared across years). Taxable = 4,000 − 3,144.75 = £855.25.
  // 20% = £171.05. Nothing paid yet.
  const result = calculateGbPaye({
    code: parseGbTaxCode("1257L"),
    payDate: "2024-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2024_TABLES,
  });
  assert.equal(result.tax, "171.0500");
});

test("2024/25 PAYE: monthly £4,000 S1257L month 3 → £165.28", () => {
  // Taxable £857.50 through the MONTH-3 bands: the 2024/25 starter band tops
  // at £2,306, so month 3 allows ceiling(2,306 × 3/12) = £577 at 19%:
  // 577 × 19% = £109.63 plus (855.25 − 577) = 278.25 × 20% = £55.65 →
  // £165.28. Pricing through the annual £2,306 band instead keeps it all at
  // 19% (£162.92) — the pre-pro-rating answer this replaces.
  const result = calculateGbPaye({
    code: parseGbTaxCode("S1257L"),
    payDate: "2024-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2024_TABLES,
  });
  assert.equal(result.tax, "165.2800");
});

test("2024/25: C1257L prices exactly as 1257L — Wales needs no edition", () => {
  // Welsh-income-tax, Rates and bands for 2024 to 2025: "These rates have
  // been set by the Welsh Government" over a table identical to rUK.
  const welsh = calculateGbPaye({
    code: parseGbTaxCode("C1257L"),
    payDate: "2024-06-06",
    periodsPerYear: 12,
    periodPay: "4000",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "4000",
    tables: GB_2024_TABLES,
  });
  assert.equal(welsh.tax, "171.0500");
});

test("2024/25: BR £3,200 × 20% = £640.00; 1257L X is period-only", () => {
  // Flat BR arithmetic is year-independent; the pay date puts it in 2024/25.
  const br = calculateGbPaye({
    code: parseGbTaxCode("BR"),
    payDate: "2024-07-06",
    periodsPerYear: 12,
    periodPay: "3200",
    priorTaxablePay: "0",
    priorAddedPay: "0",
    priorTaxPaid: "0",
    periodGrossPay: "3200",
    tables: GB_2024_TABLES,
  });
  assert.equal(br.tax, "640.0000");
  // P9X(2024): "The emergency code is 1257L for all employees"; the employer
  // rates page lists the operated markers 1257L W1 / M1 / X from 6 April
  // 2024 — the X marker prices the period alone.
  assert.equal(parseGbTaxCode("1257L X").kind, "suffix");
  assert.equal((parseGbTaxCode("1257L X") as { nonCumulative: boolean }).nonCumulative, true);
});

// ---------------------------------------------------------------------------
// Mechanism 3 (continued): resolution, weeks, sweeps, basis gate
// ---------------------------------------------------------------------------

test("2024/25 resolves from its dates and refuses outside them", () => {
  assert.equal(gbResolveTaxYear("2024-04-06"), 2024);
  assert.equal(gbResolveTaxYear("2024-09-20"), 2024);
  assert.equal(gbResolveTaxYear("2025-03-20"), 2024);
  assert.equal(gbResolveTaxYear("2025-04-05"), 2024);
  // 2024-04-05 falls in 2023/24, which has no transcribed tables and is
  // refused, not priced.
  assert.throws(() => gbResolveTaxYear("2024-04-05"), /no transcribed tables for pay date 2024-04-05/);
  assert.equal(gbTaxMonthNumber("2024-04-06"), 1);
  assert.equal(gbTaxMonthNumber("2025-04-05"), 12);
  assert.equal(gbTaxWeekNumber("2024-04-06", "2024-04-06"), 1);
  assert.equal(gbTaxWeekNumber("2024-04-12", "2024-04-06"), 1);
  assert.equal(gbTaxWeekNumber("2024-04-13", "2024-04-06"), 2);
});

test("2024/25 band-boundary sweep (at, below, above) plus monotonicity", () => {
  // Starter/basic join: the 2,307th pound prices at 20%, not 19%.
  assert.equal(gbSctLiabilityUnits(230_600_00n, GB_2024_TABLES), 4_381_400n);
  assert.equal(
    gbSctLiabilityUnits(230_700_00n, GB_2024_TABLES) - gbSctLiabilityUnits(230_600_00n, GB_2024_TABLES),
    2_000n,
  );
  // Basic/intermediate join at £13,991: the next pound prices at 21%.
  assert.equal(
    gbSctLiabilityUnits(1_399_200_00n, GB_2024_TABLES) - gbSctLiabilityUnits(1_399_100_00n, GB_2024_TABLES),
    2_100n,
  );
  // Top band: the 125,141st pound prices at 48%.
  assert.equal(
    gbSctLiabilityUnits(12_514_100_00n, GB_2024_TABLES) - gbSctLiabilityUnits(12_514_000_00n, GB_2024_TABLES),
    4_800n,
  );
  // rUK basic/higher join at £37,700: the next pound prices at 40%.
  assert.equal(gbRukLiabilityUnits(3_770_000_00n, GB_2024_TABLES), 75_400_000n);
  assert.equal(
    gbRukLiabilityUnits(3_770_100_00n, GB_2024_TABLES) - gbRukLiabilityUnits(3_770_000_00n, GB_2024_TABLES),
    4_000n,
  );
  let previous = 0n;
  for (let pay = 0; pay <= 2_000_000_000; pay += 500_000) {
    const liability = gbSctLiabilityUnits(BigInt(pay), GB_2024_TABLES);
    assert.ok(liability >= previous, `monotone at ${pay}`);
    previous = liability;
  }
});

test("2024/25 cumulative basis gate follows the 2024 month-one end", () => {
  // Month 1 is complete by definition; after it, the gate still refuses the
  // gapped cases by name.
  resolveGbCumulativeBasis({
    payDate: "2024-04-20",
    starterDeclaration: null,
    hasStubs: false,
    minStubPayDate: null,
    monthOneEnd: GB_2024_MONTH_ONE_END,
  });
  assert.throws(
    () => resolveGbCumulativeBasis({
      payDate: "2024-06-06",
      starterDeclaration: null,
      hasStubs: false,
      minStubPayDate: null,
      monthOneEnd: GB_2024_MONTH_ONE_END,
    }),
    /complete in-year record/,
  );
});
