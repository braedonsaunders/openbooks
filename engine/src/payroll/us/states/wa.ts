/**
 * Washington payroll levies — Paid Family and Medical Leave (PFML) and the
 * WA Cares Fund — with no state income tax withholding.
 *
 * Washington levies no personal income tax on wages, so there is deliberately
 * NO withholding engine here and nothing is registered in
 * ./states/index.ts: `requireUsStateWithholding("WA")` keeps returning null,
 * and the readiness slot for state income tax must not be demanded of a
 * Washington employer (see the US pack's `statutorySlots`). What Washington
 * DOES levy is transcribed here, from the publications named below, so a
 * Washington payroll prices its actual obligations instead of only FICA/FUTA/SUI:
 *
 *   PFML (RCW 50A.10; Employment Security Department news release 10/29/25):
 *     2026 total premium 1.13% of gross wages to the Social Security wage
 *     base ($184,500 for 2026). Employees carry 71.43% of the total;
 *     employers with 50 or more employees carry 28.57%. Employers with fewer
 *     than 50 employees owe no employer share but still withhold and remit
 *     the employee share — so the employer half is gated on the recorded
 *     employer size, never defaulted on or off.
 *     https://esd.wa.gov/about-us/news-release/2025/paid-family-medical-leave-premium-rate-increases-113-2026
 *
 *   PFML 2025 (Employment Security Department news release 10/23/24): total
 *     premium 0.92% of gross wages to the Social Security wage base
 *     ($176,100 for 2025, per the Social Security Administration's maximum
 *     taxable earnings table). Employees carry 71.52% of the total;
 *     employers with 50 or more employees carry 28.48% — a different split
 *     from 2024 and 2026, taken from the announcement, never carried over.
 *     https://esd.wa.gov/about-us/news-release/2024/paid-family-medical-leave-premiums-increase-2025
 *
 *   PFML 2024 (Employment Security Department news release, fall 2023):
 *     total premium 0.74% of gross wages to the Social Security wage base
 *     ($168,600 for 2024). Employees carry 71.43%; employers with 50 or more
 *     employees carry 28.57%.
 *     https://esd.wa.gov/about-us/news-release/2023/paid-family-medical-leave-premiums-decrease-2024
 *
 *   WA Cares Fund (RCW 50B.04; WA Cares Fund employer guidance):
 *     0.58% of gross wages, employee-paid, with no wage-base cap. Premium
 *     collection began July 1, 2023. The rate is statutory, unchanged across
 *     2024–2026, so every transcribed year carries the same figure.
 *     https://wacaresfund.wa.gov/employers
 *
 * All arithmetic is exact bigint. No floats.
 */
import { D, max0, mulRateCents, mulRatioCents, U, bmin } from "../../../money/payroll-decimal.ts";
import { PayrollError } from "../../error.ts";

/**
 * Operator-entered rates for a year the pack has not shipped, read off the
 * US pack's "us_wa_pfml" statutory-rate slot (Payroll Setup → Statutory
 * rates). Same five figures as a transcribed edition, so the money path
 * prices a back-fill exactly as it prices the pack's own table.
 */
export interface WaBackfillRates {
  pfmlTotalRate: string;
  pfmlEmployeeShare: string;
  pfmlEmployerShare: string;
  pfmlWageBase: string;
  caresRate: string;
}

export interface WaYearRates {
  year: number;
  status: "published" | "draft";
  /**
   * PFML total premium as a decimal (2026: 1.13%). The employee/employer
   * split below always prices shares OF this total, so the two legs sum to
   * exactly the accrued liability — never two independently rounded rates
   * that drift a cent apart from it.
   */
  pfmlTotalRate: string;
  /** Employee share of the PFML total, as a decimal (2026: 71.43%). */
  pfmlEmployeeShare: string;
  /** Employer (50+ employees) share of the PFML total (2026: 28.57%). */
  pfmlEmployerShare: string;
  /**
   * PFML taxable wage base for the year. Washington tracks the federal
   * Old-Age, Survivors, and Disability Insurance base (2026: $184,500).
   */
  pfmlWageBase: string;
  /** WA Cares employee premium as a decimal (0.58%), uncapped. */
  caresRate: string;
}

/**
 * The PFML/Cares edition for 2024 pay dates. Converting businesses back-fill
 * prior years, so every transcribed year stays published with its own
 * announcement figures — never derived from a neighboring year.
 */
export const WA_RATES_2024: WaYearRates = {
  year: 2024,
  status: "published",
  // ESD news release, fall 2023: "The premium rate will be 0.74%."
  // "Employers will pay 28.57% of the total premium and employees will pay
  // 71.43%."
  pfmlTotalRate: "0.0074",
  pfmlEmployeeShare: "0.7143",
  pfmlEmployerShare: "0.2857",
  // The family-leave wage base is the federal OASDI base, $168,600 for 2024
  // (Social Security Administration, Maximum Taxable Earnings table).
  pfmlWageBase: "168600",
  // RCW 50B.04.080: 0.58% of wages, employee-paid, no cap.
  caresRate: "0.0058",
};

/**
 * The PFML/Cares edition for 2025 pay dates.
 */
export const WA_RATES_2025: WaYearRates = {
  year: 2025,
  status: "published",
  // ESD news release 10/23/24: "The premium rate will be 0.92%. The rate
  // for 2024 is 0.74%." — "Employers will pay 28.48% of the total premium
  // and employees will pay 71.52%."
  pfmlTotalRate: "0.0092",
  pfmlEmployeeShare: "0.7152",
  pfmlEmployerShare: "0.2848",
  // The family-leave wage base is the federal OASDI base, $176,100 for 2025.
  pfmlWageBase: "176100",
  // RCW 50B.04.080: 0.58% of wages, employee-paid, no cap.
  caresRate: "0.0058",
};

/**
 * The current PFML/Cares edition for 2026 pay dates.
 */
export const WA_RATES_2026: WaYearRates = {
  year: 2026,
  status: "published",
  // ESD news release 10/29/25: "The premium rate will be 1.13%. The rate
  // for 2025 is 0.92%." — "Employers will pay 28.57% of the total premium
  // and employees will pay 71.43%."
  pfmlTotalRate: "0.0113",
  pfmlEmployeeShare: "0.7143",
  pfmlEmployerShare: "0.2857",
  // The family-leave wage base is the federal OASDI base, $184,500 for 2026.
  pfmlWageBase: "184500",
  // RCW 50B.04.080: 0.58% of wages, employee-paid, no cap.
  caresRate: "0.0058",
};

const WA_EDITIONS_BY_YEAR: Record<number, WaYearRates> = {
  [WA_RATES_2024.year]: WA_RATES_2024,
  [WA_RATES_2025.year]: WA_RATES_2025,
  [WA_RATES_2026.year]: WA_RATES_2026,
};

/**
 * Whether the pack's transcribed table covers a pay-date year. The money
 * path and the rate-slot waiver both read this, so the pack winning over an
 * operator-entered back-fill is one predicate, never two copies of the
 * edition list that can disagree about which years are shipped.
 */
export function waPackCoversYear(year: number): boolean {
  return WA_EDITIONS_BY_YEAR[year]?.status === "published";
}

/**
 * The rates for a pay date's year: the pack's transcribed table wins wherever
 * one is published; an operator-entered back-fill covers a year the pack has
 * not shipped. Anything else refuses with the operator's remedy — entering
 * the year's published figures through Payroll Setup → Statutory rates, or
 * contacting support. (Developer note: shipping a year means transcribing
 * its Employment Security Department premium announcement into
 * WA_EDITIONS_BY_YEAR above with the announcement's citation — the refusal
 * below deliberately carries none of that.)
 */
export function waRatesForPayDate(payDate: string, backfill?: WaBackfillRates): WaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WA_EDITIONS_BY_YEAR[year];
  if (rates && rates.status === "published") return rates;
  if (backfill && Number.isInteger(year)) {
    assertBackfillShares(backfill);
    return { year, status: "published", ...backfill };
  }
  throw new PayrollError(
    `Washington PFML and WA Cares have no rates for ${Number.isInteger(year) ? year : payDate} ` +
      `in this pack version — enter the year's published rates in Payroll Setup → Statutory rates ` +
      `(US · Washington PFML back-fill) with the official Employment Security Department citation, ` +
      `or contact support. Refused by name.`,
  );
}

/**
 * A back-fill row is only usable when its two shares price exactly the total
 * they split: legs that drift a cent from the accrued liability cannot tie
 * to the ESD remittance. The write boundary already holds every field to its
 * scale and range; this is the one cross-field invariant it cannot state, so
 * the money path enforces it before pricing a cent.
 */
function assertBackfillShares(backfill: WaBackfillRates): void {
  const remedy =
    "correct the shares in Payroll Setup → Statutory rates " +
    "(US · Washington PFML back-fill) so employee and employer sum to exactly 100%";
  for (const [key, value] of Object.entries(backfill)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PayrollError(`Washington PFML back-fill refused: "${key}" is missing — ${remedy}.`);
    }
  }
  let employee: { num: bigint; den: bigint };
  let employer: { num: bigint; den: bigint };
  try {
    employee = shareRatio(backfill.pfmlEmployeeShare);
    employer = shareRatio(backfill.pfmlEmployerShare);
  } catch {
    throw new PayrollError(
      `Washington PFML back-fill refused: the entered shares are not plain decimals — ${remedy}.`,
    );
  }
  if (employee.num * employer.den + employer.num * employee.den !== employee.den * employer.den) {
    throw new PayrollError(
      `Washington PFML back-fill refused: the entered employee and employer shares do not sum ` +
        `to exactly 100% of the total premium — ${remedy}.`,
    );
  }
}

/**
 * A published share ("0.7143") as an exact ratio. The split prices shares of
 * the rounded total, so the edition keeps the publication's own figures and
 * no independently rounded 8-place rate ever enters the code.
 */
function shareRatio(share: string): { num: bigint; den: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(share.trim());
  if (!match) throw new PayrollError(`not a plain decimal share: "${share}"`);
  const fraction = match[2] ?? "";
  return { num: BigInt(`${match[1]}${fraction}`), den: 10n ** BigInt(fraction.length) };
}

export type WaPfmlEmployerSize = "fifty_or_more" | "fewer_than_fifty";

/**
 * Washington PFML premium — the employee share withheld and the employer
 * contribution, on covered wages to the year's wage base.
 *
 * The total prices first (1.13% of the room left under the base, using the
 * Social Security wage history the run already accumulates, as Connecticut
 * Paid Leave does); the employee share is 71.43% of that total and the
 * employer leg is the remainder, so the two stub legs always sum to the
 * accrued total. A smaller employer owes no employer share but still
 * withholds the employee's — size is the employer's recorded fact, resolved
 * by the caller, never defaulted here.
 */
export function waPfmlWithholding(
  payDate: string,
  coveredWages: string,
  ytdCoveredWages: string,
  employerSize: WaPfmlEmployerSize,
  backfill?: WaBackfillRates,
): { total: string; employee: string; employer: string } {
  const rates = waRatesForPayDate(payDate, backfill);
  const room = max0(U(rates.pfmlWageBase) - U(ytdCoveredWages));
  const priced = D(bmin(U(coveredWages), room));
  const total = mulRateCents(U(priced), rates.pfmlTotalRate);
  const employeeShare = shareRatio(rates.pfmlEmployeeShare);
  const employee = mulRatioCents(total, employeeShare.num, employeeShare.den);
  const employer = employerSize === "fifty_or_more" ? total - employee : 0n;
  return { total: D(total), employee: D(employee), employer: D(employer) };
}

/**
 * WA Cares Fund employee premium — 0.58% of gross wages, no wage-base cap,
 * withheld beside income tax, never folded into it.
 */
export function waCaresWithholding(
  payDate: string,
  coveredWages: string,
  backfill?: WaBackfillRates,
): string {
  const rates = waRatesForPayDate(payDate, backfill);
  return D(mulRateCents(U(coveredWages), rates.caresRate));
}

export const WA_FACTOR_LABELS: Readonly<Record<string, string>> = {
  WA_PFML_TOTAL: "Washington PFML total premium",
  WA_PFML_EMPLOYEE: "Washington PFML employee premium",
  WA_PFML_EMPLOYER: "Washington PFML employer contribution",
  WA_CARES_EMPLOYEE: "Washington WA Cares employee premium",
};
