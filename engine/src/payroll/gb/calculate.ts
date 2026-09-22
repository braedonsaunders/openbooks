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
 * - PAYE: HMRC's "Specification for PAYE Tax Table Routines" (the
 *   payroll-software spec) governs every rounding step, and this engine
 *   implements it literally: Taxable Pay to date Un is rounded DOWN to the
 *   whole pound (Tn) before the formulae (§4.4.4); Income Tests compare the
 *   unrounded Un against the £1-ceiling Cvalues (Definitions 9–10); each Tax
 *   Formula computes to 4dp with no correction on the exact thresholds and
 *   threshold taxes, then floors to the penny (§4.4.4–4.4.5); free and
 *   additional pay are elapsed × the penny-ceiled Week1/Month1 value with
 *   the >500 decomposition (§4.3.1–4.3.2); the Maxrate cap floors to the
 *   penny (§4.5.2). The manual Tax Tables B-D print the Cvalues (Column 1)
 *   but compute their tax on the exact amounts (§2.5) — pricing the tax
 *   through the printed £1 figures is pennies off the spec. `gbRoundPennyUnits`
 *   (half down) below now serves NIC only.
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
 * Liability on ANNUAL taxable pay units across a transcribed band table, in
 * 1e4 units. Annual semantics only: a full year's taxable pay (the
 * K475/1257L goldens price here). Every rate is a whole percent parsed
 * exactly — no float ever prices money. Period and to-date pay prices
 * through the spec Tax Formulae (`gbSpecTaxToDateUnits`) below, never here.
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

/** Floor non-negative 1e4 units down to the whole pound. */
function gbFloorPoundUnits(units: bigint): bigint {
  return (units / 10_000n) * 10_000n;
}

/** Floor non-negative 1e4 units down to the penny. */
function gbFloorPennyUnits(units: bigint): bigint {
  return (units / 100n) * 100n;
}

/**
 * Ceiling an exact non-negative rational num/den (1e4 units per £1) up to
 * the penny, in one division: flooring first and then ceiling can mis-ceil
 * when the fraction sits within a unit above a penny boundary, so the
 * ceiling is taken on the unrounded quotient.
 */
function gbCeilPennyQuotientUnits(num: bigint, den: bigint): bigint {
  return ((num + den * 100n - 1n) / (den * 100n)) * 100n;
}

function gbSpecPeriodGuard(periodsPerYear: number, elapsed: number): void {
  if (periodsPerYear !== 12 && periodsPerYear !== 52) {
    throw new PayrollPackError(
      `GB PAYE runs on weekly or monthly payrolls only (periods-per-year ${periodsPerYear}): `
      + "the software spec's tax routines are weekly/monthly tables, anything else defers to "
      + "the CWG2 week/month mapping, which this pack has not transcribed",
    );
  }
  if (!Number.isInteger(elapsed) || elapsed < 1 || elapsed > periodsPerYear) {
    throw new PayrollPackError(`GB PAYE needs an elapsed-period count within the year, got ${elapsed}`);
  }
}

/**
 * A spec Cvalue (Definition 10): the Income-Test top for one annual band at
 * elapsed/P of the year — the exact threshold (Definition 9, cumulative
 * bandwidth × n / 52 or /12, 4dp, no correction) rounded UP to the whole
 * pound where needed. These are the round-pound Column 1 figures in the
 * manual Tax Tables C (month-1 basic £3,142, month-2 £6,284, higher month-1
 * £10,429, week-1 £725) — but the tax itself is NEVER priced through them
 * (§2.5: "the amount of tax is correctly computed on the exact amounts").
 * Cvalues choose the formula; exact thresholds price it.
 */
export function gbCvalueUnits(annualUpTo: string, periodsPerYear: number, elapsed: number): bigint {
  gbSpecPeriodGuard(periodsPerYear, elapsed);
  const num = annualUnits(annualUpTo) * BigInt(elapsed);
  const den = BigInt(periodsPerYear);
  // Ceiling on the unrounded quotient: flooring to 4dp first can mis-ceil
  // when the fraction sits within a unit above a pound boundary.
  return ((num + den * 10_000n - 1n) / (den * 10_000n)) * 10_000n;
}

/**
 * Tables-A value (free pay for suffix codes, additional pay for K codes) for
 * week/month `elapsed`: elapsed × the Week1/Month1 value, per §4.3.1–4.3.2.
 * The Week1 value is the code's annual value / 52 rounded UP to the penny
 * (Month1: /12); codes over 500 decompose into the ≤500 remainder value
 * plus quotient × £96.16 weekly / £416.67 monthly (§4.3.1c iv), each part
 * already rounded so the sum takes no further rounding. The annual value is
 * (number × 10) + 9 for free pay, number × 10 for additional pay (K codes
 * take no top-up — the code note prices each K unit at £10). Code 0 prices
 * zero (§4.3.1a). Only weekly/monthly payrolls: the spec has no other
 * tables (§13 defers to the CWG2 week/month mapping).
 */
export function gbTablesAValueUnits(
  codeNumber: number,
  periodsPerYear: number,
  elapsed: number,
  kind: "free" | "additional",
): bigint {
  gbSpecPeriodGuard(periodsPerYear, elapsed);
  if (!Number.isSafeInteger(codeNumber) || codeNumber < 0) {
    throw new PayrollPackError(`GB Tables-A value needs a non-negative code number, got ${codeNumber}`);
  }
  if (codeNumber === 0) return 0n;
  const quotient = Math.floor((codeNumber - 1) / 500);
  const remainder = ((codeNumber - 1) % 500) + 1;
  const remainderAnnual = BigInt(remainder * 10 + (kind === "free" ? 9 : 0)) * 10_000n;
  const chunk = periodsPerYear === 52 ? 9_616_00n : 41_667_00n;
  const first = gbCeilPennyQuotientUnits(remainderAnnual, BigInt(periodsPerYear))
    + BigInt(quotient) * chunk;
  return first * BigInt(elapsed);
}

/**
 * Tax to date (spec value Ln) on UNROUNDED taxable pay to date Un, through
 * one year's transcribed bands, at elapsed/P of the year — the Stage-3 Tax
 * Formulae (§4.4.4–4.4.5, summary Appendix E):
 *
 * - Income Tests run on Un against the Cvalues (Definition 10): the first
 *   band whose Cvalue reaches Un selects the formula.
 * - The selected formula prices Tn — Un rounded DOWN to the whole pound —
 *   through the EXACT thresholds (Definition 9: cumulative bandwidth × n /
 *   P, 4dp, no correction) and threshold taxes (Definition 11, likewise):
 *   Ln = k + (Tn − c) × rate, computed to 4dp with no correction.
 * - Ln is floored to the penny (§4.4.4: "round down the result if necessary
 *   to the nearest multiple of 1p below").
 *
 * The transcribed tables start at the first chargeable band, but the spec's
 * band 1 is the zero-width 10% starting band (B1 = 0 in every transcribed
 * year and region), so its test (Un ≤ 0) never fires for the Un > 0 this
 * function receives and its formula (0 + Tn × R1) is subsumed by the first
 * transcribed band priced from the (0, 0) origin below. The §16.2 refined
 * formulae are deliberately NOT used (§16.4: "their use is not recommended").
 */
function gbSpecTaxToDateUnits(
  unUnits: bigint,
  bands: readonly { upTo: string | null; rate: string }[],
  periodsPerYear: number,
  elapsed: number,
): bigint {
  gbSpecPeriodGuard(periodsPerYear, elapsed);
  if (unUnits <= 0n) return 0n;
  const tn = gbFloorPoundUnits(unUnits);
  let prevThreshold = 0n;
  let prevThresholdTax = 0n;
  let cumTop = 0n;
  let cumTax = 0n;
  for (const band of bands) {
    if (band.upTo != null) {
      const top = annualUnits(band.upTo);
      cumTax += applyRate(top - cumTop, band.rate);
      cumTop = top;
      const threshold = (cumTop * BigInt(elapsed)) / BigInt(periodsPerYear);
      const thresholdTax = (cumTax * BigInt(elapsed)) / BigInt(periodsPerYear);
      // The Cvalue ceilings the unrounded threshold, never the truncated one.
      const rawTop = cumTop * BigInt(elapsed);
      const cvalue = ((rawTop + BigInt(periodsPerYear) * 10_000n - 1n)
        / (BigInt(periodsPerYear) * 10_000n)) * 10_000n;
      if (unUnits <= cvalue) {
        return gbFloorPennyUnits(prevThresholdTax + applyRate(tn - prevThreshold, band.rate));
      }
      prevThreshold = threshold;
      prevThresholdTax = thresholdTax;
    }
  }
  const top = bands[bands.length - 1];
  if (top == null || top.upTo != null) {
    throw new PayrollPackError("GB PAYE bands must end in one open top band");
  }
  return gbFloorPennyUnits(prevThresholdTax + applyRate(tn - prevThreshold, top.rate));
}

/**
 * rUK liability on ANNUAL taxable pay units, priced from the given year's
 * bands. Annual semantics only (the K475/1257L annual goldens price here).
 * Welsh C-prefix codes price here too — the Welsh bands are identical.
 */
export function gbRukLiabilityUnits(taxableUnits: bigint, tables: GbYearTables = GB_2026_TABLES): bigint {
  return gbBandedLiabilityUnits(tables.rukBands, taxableUnits);
}

/**
 * Scottish liability on ANNUAL taxable pay units, priced from the given
 * year's starter..top bands. NIC is untouched — it remains reserved and
 * UK-wide, so only the PAYE entry point below selects this table (never the
 * NIC one).
 */
export function gbSctLiabilityUnits(taxableUnits: bigint, tables: GbYearTables = GB_2026_TABLES): bigint {
  return gbBandedLiabilityUnits(tables.sctBands, taxableUnits);
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
 * One period of PAYE for an operated code, priced by HMRC's "Specification
 * for PAYE Tax Table Routines" (the payroll-software spec):
 *
 * - periodPay is the period's taxable pay (income + non-periodic − pre-tax
 *   pension, derived by the caller); priors are the in-year sums from
 *   committed stubs.
 * - Cumulative suffix/K codes (§4): free/additional pay to date from Tables
 *   A (§4.3.1: elapsed × the ceiled Week1/Month1 value), Taxable Pay to date
 *   Un (§4.3.3), tax to date Ln from the Stage-3 formulae (§4.4.4–4.4.5),
 *   due = Ln − tax already paid (Stage 4).
 * - Non-cumulative codes (§8) price exactly as Week 1/Month 1 (§8.1–8.3):
 *   elapsed 1, no priors, no carry-forward of any capped amount.
 * - A week-53 payment on a cumulative code prices non-cumulatively on the
 *   Week 1 tables (§14: "Tables for Weeks 1, 2 or 4 as appropriate on a
 *   non-cumulative basis" — a weekly payroll's extra payment covers one
 *   week, so Week 1; monthly payrolls have no week 53).
 * - The regulatory Maxrate cap (§4.5.2, M = 50%: Ln may not exceed
 *   L(n−1) + 50% × (pay − payrolled benefits)) applies to every banded
 *   path: here due = min(due, floor(50% × period gross)), and any unrelieved
 *   amount carries forward automatically because the next period deducts
 *   from what was actually paid. There is no payrolled-benefits channel, so
 *   the cap base is the whole period gross pay. Flat-rate codes need no cap:
 *   48% is the highest flat rate, below Maxrate by construction.
 *   Negative pay is refused at entry, so §4.5.4 (negative pay forces the
 *   limit to zero) is unreachable.
 * - Flat-rate codes (BR/D0/D1, SBR/SD0–SD3) operate period-basis per §9
 *   (payment floored to £1, rate applied, result floored to 1p). The
 *   cumulative flat operation (§5/§6, taxing cumulative pay to date less
 *   prior paid) has no channel here — flat codes never read priors — so for
 *   varying pay with pennies this path can differ pennies from §5; steady
 *   pay telescopes identically.
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
  if (periodsPerYear !== 12 && periodsPerYear !== 52) {
    throw new PayrollPackError(
      `GB PAYE runs on weekly or monthly payrolls only (periods-per-year ${periodsPerYear}): `
      + "the software spec's tax routines are weekly/monthly tables, anything else defers to "
      + "the CWG2 week/month mapping, which this pack has not transcribed",
    );
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
    // §9.1–9.2: the payment floored to the whole pound, the whole of it at
    // the code's rate, the result floored to the penny. The rate rides the
    // code itself: SBR/SD0–SD3 carry Scottish rates, BR/D0/D1 rUK ones.
    const tax = gbFloorPennyUnits(applyRate(gbFloorPoundUnits(period), code.rate));
    return { tax: fromUnits(tax), periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }
  // Scottish-taxpayer status follows the S-prefix code (the employee's main
  // home is in Scotland — letters page), so the CODE selects the band table:
  // S-codes price through the Scottish starter..top bands, everything else
  // (including Welsh C-prefix codes, whose bands are identical to rUK)
  // through rUK. The bands come from the year's tables (2026/27 when
  // omitted), so a prior-year correction prices that year's bands, never the
  // current year's. NIC never reaches this selector.
  const bands = code.scottish ? tables.sctBands : tables.rukBands;
  // The 50%-of-pay regulatory cap (§4.5.2, M = 50%), floored to the penny
  // like every formula result. `due` below is already penny-exact.
  const maxrateCap = gbFloorPennyUnits(gross / 2n);
  const cap = (due: bigint): bigint => (due > maxrateCap ? maxrateCap : due);

  const priceUnrounded = (unUnits: bigint, elapsed: number): bigint =>
    gbSpecTaxToDateUnits(unUnits, bands, periodsPerYear, elapsed);

  const elapsed = periodsPerYear === 12
    ? gbTaxMonthNumber(payDate)
    : gbTaxWeekNumber(payDate, tables.yearStart);
  // Week 53 (§14) and W1/M1/X markers (§8) both price non-cumulatively on
  // the week/month-1 tables: elapsed 1, priors ignored, no carry-forward.
  const periodOnly = code.nonCumulative || elapsed > periodsPerYear;
  if (periodOnly) {
    if (code.kind === "k") {
      const added = gbTablesAValueUnits(code.number, periodsPerYear, 1, "additional");
      return {
        tax: fromUnits(cap(priceUnrounded(period + added, 1))),
        periodTaxablePay: input.periodPay,
        periodAddedPay: fromUnits(added),
      };
    }
    const free = gbTablesAValueUnits(code.number, periodsPerYear, 1, "free");
    return {
      tax: fromUnits(cap(priceUnrounded(period - free, 1))),
      periodTaxablePay: input.periodPay,
      periodAddedPay: "0.0000",
    };
  }

  if (code.kind === "k") {
    const addedToDate = gbTablesAValueUnits(code.number, periodsPerYear, elapsed, "additional");
    const addedPeriod = addedToDate - priorAdded;
    const cumLiability = priceUnrounded(priorPay + period + addedToDate, elapsed);
    return {
      tax: fromUnits(cap(cumLiability - priorPaid)),
      periodTaxablePay: input.periodPay,
      periodAddedPay: fromUnits(addedPeriod < 0n ? 0n : addedPeriod),
    };
  }
  // Flat, none and K codes all returned above: only a suffix code reaches
  // here, priced through its own Tables-A free pay (§4.3.1).
  const free = gbTablesAValueUnits(code.number, periodsPerYear, elapsed, "free");
  const cumLiability = priceUnrounded(priorPay + period - free, elapsed);
  return {
    tax: fromUnits(cap(cumLiability - priorPaid)),
    periodTaxablePay: input.periodPay,
    periodAddedPay: "0.0000",
  };
}
