import { toCents } from "../../money.ts";
import { PayrollError } from "../../payroll-error.ts";
import type {
  PayrollStatutoryComputeContext,
} from "../statutory-context.ts";
import {
  SG_CPF_2026_LE55,
  SG_OW_CEILING_MONTHLY_2026,
  SG_SDL_2026,
  SG_TRANSCRIBED_YEARS,
  type SgAgeBand,
  type SgCpfStatus,
} from "./rates.ts";

/**
 * The 2026 CPF/SDL engine: Table 1 (55 & below, OW only) plus the Skills
 * Development Levy as pure functions over integer cents (bigint). No
 * floating point anywhere; every rounding below is the Board's own rule,
 * quoted at the step.
 *
 * CPF rounding (Table 1 steps 1–3): the total is "rounded to the nearest
 * dollar, i.e., to be rounded down for an amount less than 50 cents and
 * rounded up for an amount of 50 cents and above" (half up); the
 * employee's share is "rounded down to the nearest dollar" (floor); the
 * "Employer's share = Total contribution - Employee's share" (a
 * difference, never independently rounded).
 *
 * Money in, money out: every amount below is whole dollars for CPF (the
 * Board prices in dollars) and cents for SDL. Decimal strings at the
 * boundary, never floats.
 */

// ---------------------------------------------------------------------------
// Exact parsing
// ---------------------------------------------------------------------------

/**
 * Pipeline money → cents through the ledger's own boundary (money.ts
 * `toCents`, the pack-interface contract on `PayrollStatutoryComputeContext`).
 * Accepts every shape the pipeline emits — "0.0000" included — and rounds a
 * sub-cent fraction half-up to the cent. Negatives are refused by name.
 */
function parseCents(value: string, what: string): bigint {
  let cents: bigint;
  try {
    cents = toCents(value);
  } catch {
    throw new PayrollError(`the SG payroll pack cannot price ${what}: "${value}" is not a non-negative money amount`);
  }
  if (cents < 0n) throw new PayrollError(`the SG payroll pack cannot price ${what}: "${value}" is not a non-negative money amount`);
  return cents;
}

/** Canonical numeric(19,4) from cents, matching the CA/US factor format. */
function d4(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${((abs % 100n) * 100n).toString().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Year resolution: 2026 only, everything else throws by name
// ---------------------------------------------------------------------------

/** Resolve the transcribed rates for a tax year; anything else is refused by name. */
export function sgRatesForTaxYear(year: number): 2026 {
  if (!(SG_TRANSCRIBED_YEARS as readonly number[]).includes(year)) {
    throw new PayrollError(
      `the SG payroll pack has no transcribed CPF tables for ${year} — 2026 is transcribed `
      + "(CPF Contribution Rate Table from 1 January 2026, Table 1); no other year is",
    );
  }
  return 2026;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface SgStatutoryInput {
  /** Ordinary Wages for the calendar month (OW). Additional Wages ride `nonPeriodic`. */
  ordinaryWages: string;
  /** Additional Wages for the month: always refused — the AW ceiling is year-dependent. */
  additionalWages?: string | null;
  cpfStatus: SgCpfStatus;
  ageBand: SgAgeBand;
}

export interface SgStatutoryResult {
  /** OW subject to CPF after the $8,000 monthly ceiling, cents. */
  owSubjectCents: bigint;
  /** Total CPF contribution, whole dollars as cents. */
  totalCents: bigint;
  /** Employee share, whole dollars as cents (rounded DOWN). */
  employeeCents: bigint;
  /** Employer share = total − employee, whole dollars as cents. */
  employerCents: bigint;
  /** SDL for the month, cents. */
  sdlCents: bigint;
}

const STATUSES: readonly string[] = ["citizen", "spr_3rd_year", "spr_1st_year", "spr_2nd_year", "foreigner"];
const AGE_BANDS: readonly string[] = ["le55", "b55_60", "b60_65", "b65_70", "gt70"];

const AGE_BAND_LABELS: Record<SgAgeBand, string> = {
  le55: "55 & below",
  b55_60: "Above 55 - 60",
  b60_65: "Above 60 - 65",
  b65_70: "Above 65 - 70",
  gt70: "Above 70",
};

/** Refuse every status/age combination round one does not compute, by name. */
export function assertSgCovered(status: SgCpfStatus, ageBand: SgAgeBand): void {
  if (!STATUSES.includes(status)) {
    throw new PayrollError(
      `the SG payroll pack cannot price CPF status "${status}" — declare "citizen", "spr_3rd_year", `
      + `"spr_1st_year", "spr_2nd_year" or "foreigner"`,
    );
  }
  if (!AGE_BANDS.includes(ageBand)) {
    throw new PayrollError(
      `the SG payroll pack cannot price age band "${ageBand}" — declare "le55", "b55_60", "b60_65", `
      + `"b65_70" or "gt70"`,
    );
  }
  if (status === "foreigner") {
    throw new PayrollError(
      "the SG payroll pack computes no CPF for a foreign employee — the CPF Board exempts "
      + "\"Persons who are not Singapore Citizens or Singapore Permanent Residents\" (Who should "
      + "receive CPF contributions), and foreign workers attract a Ministry of Manpower levy instead, "
      + "whose schedule is not transcribed",
    );
  }
  if (status === "spr_1st_year" || status === "spr_2nd_year") {
    throw new PayrollError(
      `the SG payroll pack refuses ${status === "spr_1st_year" ? "1st-year" : "2nd-year"} SPR graduated rates by name — `
      + "Tables 2–5 (graduated G/G and F/G rates) are not transcribed; only Table 1 (citizens and "
      + "3rd-year SPRs) computes",
    );
  }
  if (ageBand !== "le55") {
    throw new PayrollError(
      `the SG payroll pack refuses the "${AGE_BAND_LABELS[ageBand]}" age band by name — only the Table 1 `
      + `"55 & below" row (37% total / 20% employee, max $2,960 / $1,600) is transcribed`,
    );
  }
}

export function calculateSgStatutory(input: SgStatutoryInput): SgStatutoryResult {
  assertSgCovered(input.cpfStatus, input.ageBand);

  const aw = parseCents(input.additionalWages ?? "0", "Additional Wages");
  if (aw > 0n) {
    // The AW ceiling is "$102,000 - Total Ordinary Wages (OW) subject to CPF
    // for the year" — a YEAR-dependent cap no per-month channel carries, so
    // any AW prices against a guessed ceiling. Refused, not approximated.
    throw new PayrollError(
      `the SG payroll pack refuses Additional Wages of $${input.additionalWages} by name — the AW ceiling `
      + "($102,000 − the year's total OW subject to CPF) depends on year-to-date Ordinary Wages the "
      + "run does not carry, and a placeholder ceiling would silently misprice the CPF on every bonus",
    );
  }

  const ow = parseCents(input.ordinaryWages, "Ordinary Wages");
  const ceiling = parseCents(SG_OW_CEILING_MONTHLY_2026, "OW ceiling");
  const owSubject = ow > ceiling ? ceiling : ow;

  // Table 1, 55 & below. With no AW, TW = OW and the rows price on owSubject.
  // "$50 or less: Nil / Nil".
  let totalDollars = 0n;
  let employeeDollars = 0n;
  if (owSubject > 5000n) {
    if (owSubject <= 50000n) {
      // "> $50 to $500: 17% (TW)" total, employee "Nil".
      totalDollars = (owSubject * 17n + 5000n) / 10000n;
    } else if (owSubject <= 75000n) {
      // "> $500 to $750: 17% (TW) + 0.6 (TW - $500)" total,
      // "0.6 (TW - $500)" employee. Common denominator $/10000:
      // 17% = 17/10000 per cent; 0.6¢ = 60/10000 $ per cent.
      const over = owSubject - 50000n;
      totalDollars = (owSubject * 17n + over * 60n + 5000n) / 10000n;
      employeeDollars = (over * 6n) / 1000n;
    } else {
      // "> $750: [37% (OW)]*" total ("* Max. of $2,960"), "[20% (OW)]*"
      // employee ("* Max. of $1,600"). The maxima cap the OW leg, which is
      // the whole contribution with no AW.
      totalDollars = (owSubject * 37n + 5000n) / 10000n;
      employeeDollars = (owSubject * 20n) / 10000n;
      const maxTotal = parseCents(SG_CPF_2026_LE55.maxTotalOw, "maximum total on OW") / 100n;
      const maxEmployee = parseCents(SG_CPF_2026_LE55.maxEmployeeOw, "maximum employee share on OW") / 100n;
      if (totalDollars > maxTotal) totalDollars = maxTotal;
      if (employeeDollars > maxEmployee) employeeDollars = maxEmployee;
    }
  }
  // Rounding per Table 1 steps 1–3: the total rounds half up to the dollar
  // (done above); the employee share rounds DOWN to the dollar — the OW-leg
  // formulas above already yield whole dollars, and the division floors keep
  // it so; the employer share is the difference, never rounded itself.
  const employerDollars = totalDollars - employeeDollars;

  // SDL on monthly total wages (= OW with no AW): "0.25% of the monthly
  // total wages", "$2 for an employee earning less than $800 a month",
  // "$11.25 for an employee earning more than $4,500 a month". The Board
  // publishes no per-employee cent rule (only the employer total "round[s]
  // down to the nearest dollar"), so the line prices 0.25% half up to the
  // cent — stated here, not hidden in arithmetic.
  const w = parseCents(input.ordinaryWages, "monthly total wages");
  let sdlCents = (w * 25n + 5000n) / 10000n;
  if (w < parseCents(SG_SDL_2026.minWage, "SDL floor wage") && sdlCents < 200n) sdlCents = 200n;
  if (w > parseCents(SG_SDL_2026.maxWage, "SDL cap wage") && sdlCents > 1125n) sdlCents = 1125n;

  return {
    owSubjectCents: owSubject,
    totalCents: totalDollars * 100n,
    employeeCents: employeeDollars * 100n,
    employerCents: employerDollars * 100n,
    sdlCents,
  };
}

// ---------------------------------------------------------------------------
// Pack computeStatutory wiring
// ---------------------------------------------------------------------------

/**
 * SG pack statutory pass (CPF Table 1, 2026).
 *
 * Declared inputs arrive on the certificate and the line set — no
 * generic-layer channel carries them, so no FLEET-PROPOSE is needed:
 *
 * - the `sg_cpf_status` certificate (`cpf_status`, `age_band`; absent form
 *   means CPF status unknown and the run is refused, never guessed);
 * - `income` is the month's Ordinary Wages; `nonPeriodic` is Additional
 *   Wages and is always refused (the AW ceiling is year-dependent);
 * - CPF prices per calendar month, so anything but 12 periods per year is
 *   refused by name.
 */
/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the CPF Board's own (employee and
 * employer shares, Skills Development Levy) — see the module header.
 */
export const SG_FACTOR_LABELS: Readonly<Record<string, string>> = {
  CPF_EE: "CPF — employee share",
  CPF_ER: "CPF — employer share",
  CPF_TOTAL: "CPF — total",
  SDL: "Skills Development Levy",
};

export async function computeSgStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const { region, taxYear, periodsPerYear: P, income, nonPeriodic, certificateFor, assertRegionSupported } = ctx;
  assertRegionSupported(region);
  sgRatesForTaxYear(taxYear);

  if (P !== 12) {
    throw new PayrollError(
      `the SG payroll pack cannot price ${P} periods per year — CPF contributions and the $8,000 OW `
      + "ceiling are per calendar month, so only 12 monthly periods compute",
    );
  }

  const certificate = certificateFor("sg_cpf_status");
  if (certificate === null) {
    throw new PayrollError(
      "the SG payroll pack cannot price CPF without the sg_cpf_status certificate on file — the Table 1 "
      + "rate is keyed on CPF status and age band, and neither is guessed from payroll data",
    );
  }
  const status = (certificate.answers["cpf_status"] ?? "") as SgCpfStatus;
  const ageBand = (certificate.answers["age_band"] ?? "") as SgAgeBand;

  const result = calculateSgStatutory({
    ordinaryWages: income,
    additionalWages: nonPeriodic,
    cpfStatus: status,
    ageBand,
  });

  ctx.pushStatutory("cpf_ee", "deduction", "CPF — employee share", d4(result.employeeCents), 110);
  ctx.pushStatutory("cpf_er", "employer_contribution", "CPF — employer share", d4(result.employerCents), 210);
  ctx.pushStatutory("sdl", "employer_contribution", "Skills Development Levy", d4(result.sdlCents), 220);

  return {
    CPF_EE: d4(result.employeeCents),
    CPF_ER: d4(result.employerCents),
    CPF_TOTAL: d4(result.totalCents),
    SDL: d4(result.sdlCents),
  };
}
