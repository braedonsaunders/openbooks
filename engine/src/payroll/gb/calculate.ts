/**
 * The GB statutory arithmetic, pure: PAYE income tax (rUK bands) and Class 1
 * NIC (category A), no database, no floats.
 *
 * Money discipline: decimal strings at the repo's 1e4-unit scale
 * (`toUnits`/`fromUnits` from engine/src/money.ts). All rates here are whole
 * percents, so every multiplication is exact integer arithmetic; the only
 * rounding in the pack is the penny rounding below.
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

import { fromUnits, toUnits } from "../../money.ts";
import { PayrollPackError } from "../packs.ts";
import {
  GB_NIC_ANNUAL,
  GB_NIC_EMPLOYEE_MAIN_RATE,
  GB_NIC_EMPLOYEE_UPPER_RATE,
  GB_NIC_EMPLOYER_RATE,
  GB_NIC_MONTHLY,
  GB_NIC_WEEKLY,
  GB_PERSONAL_ALLOWANCE_ANNUAL,
  GB_RUK_BANDS,
  GB_TAX_YEAR,
  GB_TAX_YEAR_END,
  GB_TAX_YEAR_START,
  type GbNicThresholds,
} from "./rates.ts";
import type { GbTaxCode } from "./tax-codes.ts";

/** Last pay date whose record is complete by definition (tax month 1). */
export const GB_MONTH_ONE_END = "2026-05-05";

/** Refuse a pay date outside the transcribed 2026/27 year — never extrapolate. */
export function gbResolveTaxYear(payDate: string): number {
  if (payDate >= GB_TAX_YEAR_START && payDate <= GB_TAX_YEAR_END) return GB_TAX_YEAR;
  throw new PayrollPackError(
    `GB payroll pack has no transcribed tables for pay date ${payDate} — 2026/27 covers `
    + `${GB_TAX_YEAR_START}..${GB_TAX_YEAR_END} (see GB_TAX_YEARS). A pay date outside the `
    + "transcribed year is refused, never priced from another year's tables.",
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

/** Parse a whole-percent rate string ("0.08") to its integer percent (8n). */
function wholePercent(rate: string): bigint {
  const parts = rate.split(".");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) {
    throw new PayrollPackError(`GB rate is a whole-percent decimal, got "${rate}"`);
  }
  const frac = (parts[1]! + "00").slice(0, 2);
  if (parts[0] !== "0" || !/^\d+$/.test(frac)) {
    throw new PayrollPackError(`GB rate is a whole-percent decimal, got "${rate}"`);
  }
  return BigInt(Number(frac));
}

/**
 * Earnings-period NIC thresholds. Published weekly/monthly/annual figures
 * for P = 52/12/1; any other positive frequency pro-rates the annual figure
 * to the penny (half down), per the CWG2 pro-rating principle.
 */
export function gbNicThresholdsForPeriod(periodsPerYear: number): GbNicThresholds {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new PayrollPackError(`GB NIC needs a positive integer periods-per-year, got ${periodsPerYear}`);
  }
  if (periodsPerYear === 52) return GB_NIC_WEEKLY;
  if (periodsPerYear === 12) return GB_NIC_MONTHLY;
  if (periodsPerYear === 1) return GB_NIC_ANNUAL;
  const prorate = (annual: string): string =>
    fromUnits(gbRoundPennyUnits(toUnits(annual) / BigInt(periodsPerYear)));
  return {
    lel: prorate(GB_NIC_ANNUAL.lel),
    pt: prorate(GB_NIC_ANNUAL.pt),
    st: prorate(GB_NIC_ANNUAL.st),
    uel: prorate(GB_NIC_ANNUAL.uel),
  };
}

export interface GbNicResult {
  /** Employee (primary) Class 1, decimal string. */
  employee: string;
  /** Employer (secondary) Class 1, decimal string. */
  employer: string;
}

/**
 * One period of category-A Class 1 NIC by the exact percentage method:
 * 8% of (UTL-capped earnings above PT) plus 2% above UEL for the employee,
 * 15% of earnings above ST for the employer — each share rounded once.
 */
export function calculateGbNic(input: {
  earnings: string;
  periodsPerYear: number;
}): GbNicResult {
  const base = toUnits(input.earnings);
  if (base < 0n) throw new PayrollPackError(`GB NIC needs non-negative earnings, got ${input.earnings}`);
  const t = gbNicThresholdsForPeriod(input.periodsPerYear);
  const pt = toUnits(t.pt);
  const st = toUnits(t.st);
  const uel = toUnits(t.uel);
  // Whole-percent rates parsed exactly ("0.08" -> 8n): no float ever prices money.
  const mainBase = base < pt ? 0n : (base < uel ? base : uel) - pt;
  const upperBase = base < uel ? 0n : base - uel;
  const employee = gbRoundPennyUnits(
    (mainBase * wholePercent(GB_NIC_EMPLOYEE_MAIN_RATE)
      + upperBase * wholePercent(GB_NIC_EMPLOYEE_UPPER_RATE)) / 100n,
  );
  const employerBase = base < st ? 0n : base - st;
  const employer = gbRoundPennyUnits(
    (employerBase * wholePercent(GB_NIC_EMPLOYER_RATE)) / 100n,
  );
  return { employee: fromUnits(employee), employer: fromUnits(employer) };
}

/** rUK liability on taxable pay units: 20/40/45 across the transcribed bands. */
export function gbRukLiabilityUnits(taxableUnits: bigint): bigint {
  if (taxableUnits <= 0n) return 0n;
  let remaining = taxableUnits;
  let liability = 0n;
  let lower = 0n;
  for (const band of GB_RUK_BANDS) {
    if (remaining <= 0n) break;
    const width = band.upTo == null ? null : annualUnits(band.upTo) - lower;
    const inBand = width == null ? remaining : (remaining < width ? remaining : width);
    const percent = BigInt(band.rate === "0.20" ? 20 : band.rate === "0.40" ? 40 : 45);
    liability += (inBand * percent) / 100n;
    remaining -= inBand;
    if (width != null) lower += width;
  }
  return liability;
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

/** HMRC tax-week number (1–53) for a pay date in 2026/27. Week 1 = 6–12 Apr. */
export function gbTaxWeekNumber(payDate: string): number {
  const start = Date.UTC(2026, 3, 6);
  const day = Date.UTC(
    Number(payDate.slice(0, 4)), Number(payDate.slice(5, 7)) - 1, Number(payDate.slice(8, 10)),
  );
  return Math.floor((day - start) / (7 * 86_400_000)) + 1;
}

/** Cumulative free pay for a standard-allowance code: allowance × elapsed / P, capped at annual. */
function cumulativeFreePayUnits(periodsPerYear: number, elapsed: number): bigint {
  const annual = annualUnits(GB_PERSONAL_ALLOWANCE_ANNUAL);
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
}): void {
  const { payDate, starterDeclaration, hasStubs, minStubPayDate } = input;
  if (payDate <= GB_MONTH_ONE_END) return;
  if (starterDeclaration === "A") return;
  if (starterDeclaration === "C" && hasStubs) return;
  if (minStubPayDate != null && minStubPayDate <= GB_MONTH_ONE_END) return;
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
}): GbPayeResult {
  const { code, payDate, periodsPerYear } = input;
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
    const percent = code.rate === "0.20" ? 20n : code.rate === "0.40" ? 40n : 45n;
    const tax = gbRoundPennyUnits((period * percent) / 100n);
    return { tax: fromUnits(tax), periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }

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
      let tax = gbRoundPennyUnits(gbRukLiabilityUnits(taxable < 0n ? 0n : taxable));
      const cap = gross / 2n;
      if (tax > cap) tax = cap;
      return {
        tax: fromUnits(tax),
        periodTaxablePay: input.periodPay,
        periodAddedPay: fromUnits(added),
      };
    }
    const allowance = code.kind === "suffix" ? toUnits(code.allowanceAnnual) : 0n;
    const free = allowance / BigInt(periodsPerYear);
    const taxable = period - free;
    const tax = gbRoundPennyUnits(gbRukLiabilityUnits(taxable < 0n ? 0n : taxable));
    return { tax: fromUnits(tax), periodTaxablePay: input.periodPay, periodAddedPay: "0.0000" };
  }

  const elapsed = periodsPerYear === 12 ? gbTaxMonthNumber(payDate) : gbTaxWeekNumber(payDate);
  if (code.kind === "k") {
    const addedAnnual = toUnits(code.addedAnnual);
    const addedToDate = (addedAnnual * BigInt(elapsed)) / BigInt(periodsPerYear);
    const addedPeriod = addedToDate - priorAdded;
    const cumTaxable = priorPay + period + addedToDate;
    const cumLiability = gbRoundPennyUnits(gbRukLiabilityUnits(cumTaxable < 0n ? 0n : cumTaxable));
    let due = cumLiability - priorPaid;
    const cap = gross / 2n;
    if (due > cap) due = cap;
    return {
      tax: fromUnits(due),
      periodTaxablePay: input.periodPay,
      periodAddedPay: fromUnits(addedPeriod < 0n ? 0n : addedPeriod),
    };
  }
  const free = code.allowanceAnnual === "0"
    ? 0n
    : cumulativeFreePayUnits(periodsPerYear, elapsed);
  const cumPay = priorPay + period;
  const cumTaxable = cumPay - free;
  const cumLiability = gbRoundPennyUnits(gbRukLiabilityUnits(cumTaxable < 0n ? 0n : cumTaxable));
  const due = cumLiability - priorPaid;
  return {
    tax: fromUnits(due),
    periodTaxablePay: input.periodPay,
    periodAddedPay: "0.0000",
  };
}
