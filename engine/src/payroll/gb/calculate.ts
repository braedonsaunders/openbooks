/**
 * The GB statutory arithmetic, pure: PAYE income tax (rUK bands) and Class 1
 * NIC (category A), no database, no floats.
 *
 * Money discipline: decimal strings at the repo's 1e4-unit scale
 * (`toUnits`/`fromUnits` from engine/src/money/money.ts). Every rate is an
 * exact decimal fraction parsed to a numerator over 10^decimals (whole
 * percents and 2024/25's 13.8% alike), so every multiplication is exact
 * integer arithmetic; the only rounding in the pack is the penny rounding below.
 *
 * Rounding (quoted, then implemented):
 * - NIC: SSCR 2001 Regulation 12(1) — "primary and secondary Class 1
 *   contributions ... shall be calculated to the nearest penny and any amount
 *   of a halfpenny or less shall be disregarded"
 *   (https://www.legislation.gov.uk/uksi/2001/1004/regulation/12). HMRC's
 *   paraphrase (NIM11002): "round NICs calculations to the nearest penny
 *   (amounts of less than £0.005 are disregarded)"; CWG2 2026/27: "calculated
 *   to the nearest penny. Amounts of £0.005 or less should be disregarded."
 *   The regulation governs the exact-half edge: £0.005 rounds DOWN.
 *   Implemented as `gbRoundPennyUnits` (round half down), applied once per
 *   share — employee and employer NICs are "calculated separately" (Reg
 *   12(1)(a) via NIM11002).
 * - NIC uses the EXACT PERCENTAGE method, not the tables method (the two
 *   differ by construction; CWG2: "You may work out National Insurance
 *   contributions using either the contribution tables ... [or the] exact
 *   percentage method"). Per-period thresholds are HMRC's published
 *   weekly/monthly/annual figures for 52/12/1 periods a year; any other
 *   frequency pro-rates the annual figure, the same principle as CWG2's
 *   daily pro-rating ("dividing the annual figures by 365 ... In all cases
 *   the resulting figures should be calculated to the nearest penny. Amounts
 *   of £0.005 or less should be disregarded").
 * - PAYE: HMRC publishes no software rounding rule — the manual tables it
 *   does publish round "taxable pay" down to the pound AND state on their
 *   cover that real-time software employers must not use them ("If you're an
 *   employer operating PAYE in real time you're no longer able to run your
 *   payroll manually and you do not need to use these manual tables. Instead
 *   you should be using software ..."). This engine is that software: it
 *   computes the cumulative liability exactly and rounds the cumulative
 *   figure half-down to the penny, so the year total is rounding-stable and
 *   only each period's split can move ±1p against any alternative rule.
 *
 * Cumulative PAYE needs the complete in-year record. `resolveGbCumulativeBasis`
 * refuses (by name) exactly the cases no product record can price: a P45
 * joiner's previous pay, a mid-year adopter's pre-adoption history, a
 * declaration-B starter's old-employer pay. See its doc comment.
 */

import { fromUnits, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { GbNicThresholds } from "./rates.ts";
import { GB_TAX_YEAR_START } from "./rates.ts";
import {
  GB_2024_TABLES,
  GB_2025_TABLES,
  GB_2026_TABLES,
  GB_MONTH_ONE_END,
  type GbYearTables,
} from "./year-tables.ts";
import type { GbTaxCode } from "./tax-codes.ts";

/** The transcribed 2026/27 month-one end, re-exported from the year tables. */
export { GB_MONTH_ONE_END };

/** Refuse a pay date outside the transcribed years — never extrapolate. */
export function gbResolveTaxYear(payDate: string): number {
  for (const tables of [GB_2026_TABLES, GB_2025_TABLES, GB_2024_TABLES]) {
    if (payDate >= tables.yearStart && payDate <= tables.yearEnd) return tables.year;
  }
  throw new PayrollPackError(
    `GB payroll pack has no transcribed tables for pay date ${payDate} — transcribed years cover `
    + `${GB_2024_TABLES.yearStart}..${GB_2026_TABLES.yearEnd} (see GB_TAX_YEARS). A pay date outside the `
    + "transcribed years is refused, never priced from another year's tables.",
  );
}

/**
 * Regulation 12(1) penny rounding on non-negative 1e4 units: nearest penny,
 * an exact half-penny (50 units) or less disregarded (rounds down).
 */
export function gbRoundPennyUnits(units: bigint): bigint {
  if (units < 0n) throw new PayrollPackError("GB penny rounding takes a non-negative amount");
  const whole = units / 100n;
  const remainder = units % 100n;
  return (remainder > 50n ? whole + 1n : whole) * 100n;
}

/** Parse an annual-figure decimal string to whole 1e4 units. */
function annualUnits(value: string): bigint {
  return toUnits(value);
}

/**
 * Parse a rate decimal string ("0.08", "0.138") to its exact numerator
 * over 10^decimals. The 2024/25 employer rate is 13.8% — not a whole
 * percent — so the parser takes the fraction the authority prints (up to
 * three decimals) rather than truncating it; every multiplication below
 * stays exact integer arithmetic.
 */
function rateFraction(rate: string): { num: bigint; den: bigint } {
  const parts = rate.split(".");
  const frac = parts[1];
  if (parts.length !== 2 || parts[0] !== "0" || frac === undefined || !/^\d{1,3}$/.test(frac)) {
    throw new PayrollPackError(`GB rate is a zero-point decimal fraction, got "${rate}"`);
  }
  return { num: BigInt(frac), den: 10n ** BigInt(frac.length) };
}

/** Liability on a base at an exact decimal rate, still in 1e4 units. */
function applyRate(baseUnits: bigint, rate: string): bigint {
  const { num, den } = rateFraction(rate);
  return (baseUnits * num) / den;
}

/**
 * Earnings-period NIC thresholds. Published weekly/monthly/annual figures
 * for P = 52/12/1; any other positive frequency pro-rates the annual figure
 * to the penny (half down), per the CWG2 pro-rating principle.
 */
export function gbNicThresholdsForPeriod(
  periodsPerYear: number,
  tables: GbYearTables = GB_2026_TABLES,
): GbNicThresholds {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new PayrollPackError(`GB NIC needs a positive integer periods-per-year, got ${periodsPerYear}`);
  }
  if (periodsPerYear === 52) return tables.nicWeekly;
  if (periodsPerYear === 12) return tables.nicMonthly;
  if (periodsPerYear === 1) return tables.nicAnnual;
  const prorate = (annual: string): string =>
    fromUnits(gbRoundPennyUnits(toUnits(annual) / BigInt(periodsPerYear)));
  return {
    lel: prorate(tables.nicAnnual.lel),
    pt: prorate(tables.nicAnnual.pt),
    st: prorate(tables.nicAnnual.st),
    uel: prorate(tables.nicAnnual.uel),
  };
}

export interface GbNicResult {
  /** Employee (primary) Class 1, decimal string. */
  employee: string;
  /** Employer (secondary) Class 1, decimal string. */
  employer: string;
}

/**
 * One period of category-A Class 1 NIC by the exact percentage method, priced
 * from the given year's tables (2026/27 when omitted): the employee main rate
 * of UEL-capped earnings above PT plus the upper rate above UEL, and the
 * employer rate of earnings above ST — each share rounded once.
 */
export function calculateGbNic(input: {
  earnings: string;
  periodsPerYear: number;
  tables?: GbYearTables;
}): GbNicResult {
  const tables = input.tables ?? GB_2026_TABLES;
  const base = toUnits(input.earnings);
  if (base < 0n) throw new PayrollPackError(`GB NIC needs non-negative earnings, got ${input.earnings}`);
  const t = gbNicThresholdsForPeriod(input.periodsPerYear, tables);
  const pt = toUnits(t.pt);
  const st = toUnits(t.st);
  const uel = toUnits(t.uel);
  // Whole-percent rates parsed exactly ("0.08" -> 8n): no float ever prices money.
  const mainBase = base < pt ? 0n : (base < uel ? base : uel) - pt;
  const upperBase = base < uel ? 0n : base - uel;
  const employee = gbRoundPennyUnits(
    applyRate(mainBase, tables.nicEmployeeMainRate) + applyRate(upperBase, tables.nicEmployeeUpperRate),
  );
  const employerBase = base < st ? 0n : base - st;
  const employer = gbRoundPennyUnits(applyRate(employerBase, tables.nicEmployerRate));
  return { employee: fromUnits(employee), employer: fromUnits(employer) };
}

/**
 * Liability on taxable pay units across a transcribed band table. Every rate
 * here is a whole percent parsed exactly (no float ever prices money); the
 * only rounding in the pack is the penny rounding at the PAYE entry point.
 * The tops here are ANNUAL (a full year's taxable pay): period and
 * to-date pricing goes through `gbPeriodicLiabilityUnits` below, never here.
 */
function gbBandedLiabilityUnits(
  bands: readonly { upTo: string | null; rate: string }[],
  taxableUnits: bigint,
): bigint {
  if (taxableUnits <= 0n) return 0n;
  let remaining = taxableUnits;
  let liability = 0n;
  let lower = 0n;
  for (const band of bands) {
    if (remaining <= 0n) break;
    const width = band.upTo == null ? null : annualUnits(band.upTo) - lower;
    const inBand = width == null ? remaining : (remaining < width ? remaining : width);
    liability += applyRate(inBand, band.rate);
    remaining -= inBand;
    if (width != null) lower += width;
  }
  return liability;
}

/**
 * One band top pro-rated to the elapsed part of the year, in 1e4 units.
 *
 * HMRC prices PAYE against the elapsed fraction of the annual bands, not the
 * annual bands themselves: a non-cumulative (W1/M1) period sees 1/P of each
 * band, and a cumulative period sees elapsed/P (HMRC Taxable Pay Tables B-D,
 * "Manual Method": each month/week row carries its own Column 1 — the
 * cumulative basic-rate limit to date — e.g. April 2023 edition p.4, English
 * monthly: 3142, 6284, 9425 ... 37700; weekly: 725, 1450 ... 37700. The
 * annual bands there are £37,700/£125,140, frozen ever since, so the rows
 * pin the 2026/27 method too).
 *
 * Rounding is CEILING to the whole pound, read off those rows, not assumed:
 * 37,700 × 2/12 = 6,283.33 rounds to 6,284 (month 2),
 * 125,140 × 1/12 = 10,428.33 rounds to 10,429 (higher month 1), and the
 * Scottish starter rows (p.12: 181, 361, 541 ... — 2,162 × 2/12 = 360.33
 * rounds to 361) agree. Round-half-up would give 6,283 / 10,428 / 360, so
 * the tables discriminate and ceiling wins. Exact annual figures stay exact
 * (month 12 is the annual band to the pound).
 */
export function gbPeriodicBandTopUnits(
  annualUpTo: string,
  periodsPerYear: number,
  elapsed: number,
): bigint {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new PayrollPackError(`GB PAYE bands need a positive integer periods-per-year, got ${periodsPerYear}`);
  }
  if (!Number.isInteger(elapsed) || elapsed <= 0) {
    throw new PayrollPackError(`GB PAYE bands need a positive integer elapsed-period count, got ${elapsed}`);
  }
  // Week 53 (a 53-week year) prices against the annual bands: there is no
  // 53rd slice of free pay or band, so the elapsed fraction clamps at one.
  const capped = Math.min(elapsed, periodsPerYear);
  const num = annualUnits(annualUpTo) * BigInt(capped);
  const den = BigInt(periodsPerYear) * 10_000n;
  return ((num + den - 1n) / den) * 10_000n;
}

/**
 * Liability on taxable pay units across pro-rated band tops: each annual
 * `upTo` scaled to ceiling(annual × elapsed / P) whole pounds, widths
 * derived top-minus-previous-top. Non-cumulative prices with elapsed 1;
 * cumulative with the tax month/week number.
 */
function gbPeriodicLiabilityUnits(
  bands: readonly { upTo: string | null; rate: string }[],
  taxableUnits: bigint,
  periodsPerYear: number,
  elapsed: number,
): bigint {
  if (taxableUnits <= 0n) return 0n;
  let remaining = taxableUnits;
  let liability = 0n;
  let lower = 0n;
  for (const band of bands) {
    if (remaining <= 0n) break;
    const width = band.upTo == null
      ? null
      : gbPeriodicBandTopUnits(band.upTo, periodsPerYear, elapsed) - lower;
    const inBand = width == null ? remaining : (remaining < width ? remaining : (width < 0n ? 0n : width));
    liability += applyRate(inBand, band.rate);
    remaining -= inBand;
    if (width != null) lower += width > 0n ? width : 0n;
  }
  return liability;
}

/**
 * rUK liability on ANNUAL taxable pay units, priced from the given year's
 * bands. Annual semantics only: a full year's taxable pay (the K475/1257L
 * goldens below price here). Period and to-date pay prices through
 * `gbRukPeriodicLiabilityUnits`, never here.
 */
export function gbRukLiabilityUnits(taxableUnits: bigint, tables: GbYearTables = GB_2026_TABLES): bigint {
  return gbBandedLiabilityUnits(tables.rukBands, taxableUnits);
}

/**
 * rUK liability on a period's (non-cumulative, elapsed 1) or to-date
 * (cumulative, elapsed = tax month/week number) taxable pay: each annual
 * band pro-rated to ceiling(annual × elapsed / P) whole pounds. Welsh
 * C-prefix codes price here too — the Welsh bands are identical to rUK.
 */
export function gbRukPeriodicLiabilityUnits(
  taxableUnits: bigint,
  periodsPerYear: number,
  elapsed: number,
  tables: GbYearTables = GB_2026_TABLES,
): bigint {
  return gbPeriodicLiabilityUnits(tables.rukBands, taxableUnits, periodsPerYear, elapsed);
}

/**
 * Scottish liability on taxable pay units, priced from the given year's
 * starter..top bands. NIC is untouched — it remains reserved and UK-wide,
 * so only the PAYE entry point below selects this table (never the NIC one).
 */
export function gbSctLiabilityUnits(taxableUnits: bigint, tables: GbYearTables = GB_2026_TABLES): bigint {
  return gbBandedLiabilityUnits(tables.sctBands, taxableUnits);
}

/**
 * Scottish liability on a period's or to-date taxable pay, pro-rated exactly
 * like the rUK twin above but through the starter..top bands. NIC is
 * untouched — it remains reserved and UK-wide, so only the PAYE entry point
 * below selects this table (never the NIC one).
 */
export function gbSctPeriodicLiabilityUnits(
  taxableUnits: bigint,
  periodsPerYear: number,
  elapsed: number,
  tables: GbYearTables = GB_2026_TABLES,
): bigint {
  return gbPeriodicLiabilityUnits(tables.sctBands, taxableUnits, periodsPerYear, elapsed);
}

/** HMRC tax-month number (1–12) for a pay date in 2026/27. Month 1 = 6 Apr–5 May. */
export function gbTaxMonthNumber(payDate: string): number {
  const month = Number(payDate.slice(5, 7));
  const day = Number(payDate.slice(8, 10));
  let index = (month - 4 + 12) % 12;
  if (day < 6) index -= 1;
  if (index < 0) index += 12;
  return index + 1;
}

/** HMRC tax-week number (1–53) for a pay date in the given year. Week 1 = 6–12 Apr. */
export function gbTaxWeekNumber(payDate: string, yearStart: string = GB_TAX_YEAR_START): number {
  const start = Date.UTC(
    Number(yearStart.slice(0, 4)), Number(yearStart.slice(5, 7)) - 1, Number(yearStart.slice(8, 10)),
  );
  const day = Date.UTC(
    Number(payDate.slice(0, 4)), Number(payDate.slice(5, 7)) - 1, Number(payDate.slice(8, 10)),
  );
  return Math.floor((day - start) / (7 * 86_400_000)) + 1;
}

/**
 * Cumulative free pay for a suffix code: the CODE's annual free pay
 * (number × 10 + 9 — 1257L carries £12,579, not the £12,570 Personal
 * Allowance; see `freePayAnnual`) × elapsed / P, capped at annual. The
 * table's personal allowance never enters: today only 1257L/0T parse so the
 * two coincide all but £9, but the code is authoritative (PAYE70025: free
 * pay "is a proportion of the employee's maximum tax allowance which is
 * reflected in the code").
 */
function cumulativeFreePayUnits(
  periodsPerYear: number,
  elapsed: number,
  freePayAnnual: string,
): bigint {
  const annual = annualUnits(freePayAnnual);
  const free = (annual * BigInt(elapsed)) / BigInt(periodsPerYear);
  return free > annual ? annual : free;
}

export type GbStarterDeclaration = "A" | "B" | "C" | null;

/**
 * Whether cumulative PAYE may run on the product's record, or throws naming
 * the gap. Allowed when the record is provably complete:
 * - the pay date is in tax month 1 (nothing in-year could precede it);
 * - starter declaration A is on file (first job since 6 April — the
 *   checklist's own wording — so zero priors are the truth, not a gap);
 * - declaration C is on file with in-product stubs (the other job is a
 *   separate employment; this job's record starts at its first stub);
 * - in-product stubs span the year start (min stub in month 1: steady
 *   employees, no checklist needed).
 * Refused: P45 joiners (previous pay on paper, no input channel until the
 * PROPOSEd opening-YTD fields land), mid-year-adopter histories, and
 * declaration-B starters (old-employer pay exists and is unrepresentable).
 * Non-cumulative codes never reach this gate — period-only needs no history.
 */
export function resolveGbCumulativeBasis(input: {
  payDate: string;
  starterDeclaration: GbStarterDeclaration;
  hasStubs: boolean;
  minStubPayDate: string | null;
  monthOneEnd?: string;
}): void {
  const { payDate, starterDeclaration, hasStubs, minStubPayDate } = input;
  const monthOneEnd = input.monthOneEnd ?? GB_MONTH_ONE_END;
  if (payDate <= monthOneEnd) return;
  if (starterDeclaration === "A") return;
  if (starterDeclaration === "C" && hasStubs) return;
  if (minStubPayDate != null && minStubPayDate <= monthOneEnd) return;
  throw new PayrollPackError(
    "GB cumulative PAYE needs the complete in-year record and it is not on file: "
    + `no starter declaration A, no in-product stubs spanning the year start (pay date ${payDate}). `
    + "A P45 joiner's previous pay and tax, a mid-year adopter's pre-adoption history, and a "
    + "declaration-B starter's old-employer pay have no input channel until GB opening-YTD fields "
    + "are allocated — operating cumulatively from zero would under-withhold. File the starter "
    + "checklist, or wait for the opening-YTD channel.",
  );
}

export interface GbPayeResult {
  /** PAYE due for the period (negative = in-year refund), decimal string. */
  tax: string;
  /** Period taxable pay priced (excludes K added pay), decimal string. */
  periodTaxablePay: string;
  /** Period K added pay priced, decimal string. */
  periodAddedPay: string;
}

/**
 * One period of rUK PAYE for an operated code.
 *
 * periodPay is the period's taxable pay (income + non-periodic − pre-tax
 * pension, derived by the caller); priors are the in-year sums from committed
 * stubs. Cumulative codes price (priors + period) through the bands and
 * deduct what is already paid; period-only codes price the period alone.
 * K codes add number×10 across the year and cap the period deduction at half
 * of period gross pay. The 50%-of-pay cap is HMRC's ("You should not deduct
 * more than 50% of your employees pay in tax", Tax Tables B-D; "cannot be
 * more than half an employee's pre-tax pay", tax-code letters page).
 */
export function calculateGbPaye(input: {
  code: GbTaxCode;
  payDate: string;
  periodsPerYear: number;
  periodPay: string;
  priorTaxablePay: string;
  priorAddedPay: string;
  priorTaxPaid: string;
  periodGrossPay: string;
  tables?: GbYearTables;
}): GbPayeResult {
  const { code, payDate, periodsPerYear } = input;
  const tables = input.tables ?? GB_2026_TABLES;
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new PayrollPackError(`GB PAYE needs a positive integer periods-per-year, got ${periodsPerYear}`);
  }
  const period = toUnits(input.periodPay);
  const priorPay = toUnits(input.priorTaxablePay);
  const priorAdded = toUnits(input.priorAddedPay);
  const priorPaid = toUnits(input.priorTaxPaid);
  const gross = toUnits(input.periodGrossPay);
  for (const [name, value] of [["period pay", period], ["prior taxable pay", priorPay],
    ["prior added pay", priorAdded], ["period gross pay", gross]] as const) {
    if (value < 0n) throw new PayrollPackError(`GB PAYE needs non-negative ${name}, got ${value}`);
  }

  if (code.kind === "none") {
    return { tax: "0.0000", periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }
  if (code.kind === "flat") {
    // The rate rides the code itself (Tables B): SBR/SD0–SD3 carry their
    // Scottish rates, BR/D0/D1 their rUK ones — no table lookup here.
    const tax = gbRoundPennyUnits(applyRate(period, code.rate));
    return { tax: fromUnits(tax), periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }
  // Scottish-taxpayer status follows the S-prefix code (the employee's main
  // home is in Scotland — letters page), so the CODE selects the band table:
  // S1257L prices through the Scottish starter..top bands, everything else
  // through rUK. The free-pay schedule is shared (£12,570 reserved
  // allowance); only the bands differ. NIC never reaches this selector.
  // The bands — and the free-pay allowance below — come from the year's
  // tables (2026/27 when omitted), so a prior-year correction prices that
  // year's bands, never the current year's.
  // Bands are pro-rated to the elapsed part of the year (HMRC Taxable Pay
  // Tables B-D Column 1): a non-cumulative period prices through 1/P of each
  // band, a cumulative one through elapsed/P. Pricing period or to-date pay
  // through the ANNUAL bands instead under-withholds every higher-rate
  // earner before month 12 — e.g. 1257L £10,000 in month 1 withheld ~£1,790
  // (all 20%) where HMRC takes ~£2,952 (see gbPeriodicBandTopUnits).
  const bandLiability = code.scottish
    ? (units: bigint, elapsedPeriods: number) =>
      gbSctPeriodicLiabilityUnits(units, periodsPerYear, elapsedPeriods, tables)
    : (units: bigint, elapsedPeriods: number) =>
      gbRukPeriodicLiabilityUnits(units, periodsPerYear, elapsedPeriods, tables);

  const cumulative = !code.nonCumulative;
  if (cumulative && periodsPerYear !== 12 && periodsPerYear !== 52) {
    throw new PayrollPackError(
      `GB cumulative PAYE runs on weekly or monthly payrolls only (periods-per-year ${periodsPerYear}): `
      + "the free-pay/add-pay schedule follows HMRC's published tax weeks and months",
    );
  }

  if (!cumulative) {
    if (code.kind === "k") {
      const added = (toUnits(code.addedAnnual) / BigInt(periodsPerYear));
      const taxable = period + added;
      let tax = gbRoundPennyUnits(bandLiability(taxable < 0n ? 0n : taxable, 1));
      const cap = gross / 2n;
      if (tax > cap) tax = cap;
      return {
        tax: fromUnits(tax),
        periodTaxablePay: input.periodPay,
        periodAddedPay: fromUnits(added),
      };
    }
    const allowance = code.kind === "suffix" ? toUnits(code.freePayAnnual) : 0n;
    const free = allowance / BigInt(periodsPerYear);
    const taxable = period - free;
    const tax = gbRoundPennyUnits(bandLiability(taxable < 0n ? 0n : taxable, 1));
    return { tax: fromUnits(tax), periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }

  const elapsed = periodsPerYear === 12
    ? gbTaxMonthNumber(payDate)
    : gbTaxWeekNumber(payDate, tables.yearStart);
  if (code.kind === "k") {
    const addedAnnual = toUnits(code.addedAnnual);
    const addedToDate = (addedAnnual * BigInt(elapsed)) / BigInt(periodsPerYear);
    const addedPeriod = addedToDate - priorAdded;
    const cumTaxable = priorPay + period + addedToDate;
    const cumLiability = gbRoundPennyUnits(bandLiability(cumTaxable < 0n ? 0n : cumTaxable, elapsed));
    let due = cumLiability - priorPaid;
    const cap = gross / 2n;
    if (due > cap) due = cap;
    return {
      tax: fromUnits(due),
      periodTaxablePay: input.periodPay,
      periodAddedPay: fromUnits(addedPeriod < 0n ? 0n : addedPeriod),
    };
  }
  // Flat, none and K codes all returned above: only a suffix code reaches
  // here, so its own free-pay annual prices (never the table's allowance).
  const free = code.freePayAnnual === "0"
    ? 0n
    : cumulativeFreePayUnits(periodsPerYear, elapsed, code.freePayAnnual);
  const cumPay = priorPay + period;
  const cumTaxable = cumPay - free;
  const cumLiability = gbRoundPennyUnits(bandLiability(cumTaxable < 0n ? 0n : cumTaxable, elapsed));
  const due = cumLiability - priorPaid;
  return {
    tax: fromUnits(due),
    periodTaxablePay: input.periodPay,
    periodAddedPay: "0.0000",
  };
}
