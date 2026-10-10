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
 *   WA Cares Fund (RCW 50B.04; WA Cares Fund employer guidance):
 *     0.58% of gross wages, employee-paid, with no wage-base cap. Premium
 *     collection began July 1, 2023.
 *
 * All arithmetic is exact bigint. No floats.
 */
import { D, max0, mulRateCents, mulRatioCents, U, bmin } from "../../../money/payroll-decimal.ts";
import { PayrollError } from "../../error.ts";

const RATES_MODULE = "engine/src/payroll/us/states/wa.ts";

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
  [WA_RATES_2026.year]: WA_RATES_2026,
};

/** The transcribed rates for a pay date's year, or a refusal naming the transcription. */
export function waRatesForPayDate(payDate: string): WaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    throw new PayrollError(
      `Washington PFML and WA Cares have no transcribed rates for ${Number.isInteger(year) ? year : payDate}. `
      + `Transcribe the year's Employment Security Department premium announcement into ${RATES_MODULE} `
      + `before calculating — refused by name`,
    );
  }
  return rates;
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
): { total: string; employee: string; employer: string } {
  const rates = waRatesForPayDate(payDate);
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
export function waCaresWithholding(payDate: string, coveredWages: string): string {
  const rates = waRatesForPayDate(payDate);
  return D(mulRateCents(U(coveredWages), rates.caresRate));
}

export const WA_FACTOR_LABELS: Readonly<Record<string, string>> = {
  WA_PFML_TOTAL: "Washington PFML total premium",
  WA_PFML_EMPLOYEE: "Washington PFML employee premium",
  WA_PFML_EMPLOYER: "Washington PFML employer contribution",
  WA_CARES_EMPLOYEE: "Washington WA Cares employee premium",
};
