import { toCents } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import type {
  PayrollStatutoryComputeContext,
} from "../statutory-context.ts";
import {
  SG_2026_AW_CEILING_AT_FULL_OW,
  SG_CPF_2026_LE55,
  SG_OW_CEILING_MONTHLY_2026,
  SG_SDL_2026,
  SG_TRANSCRIBED_YEARS,
  type SgAgeBand,
  type SgCpfStatus,
  type SgYearTables,
} from "./rates.ts";
import { SG_2024_TABLES } from "./tax-year-2024.ts";
import { SG_2025_TABLES } from "./tax-year-2025.ts";

/**
 * The 2024–2026 CPF/SDL engine: Table 1 (55 & below, OW only) plus the Skills
 * Development Levy as pure functions over integer cents (bigint). No
 * floating point anywhere; every rounding below is the Board's own rule,
 * quoted at the step. The tax year selects the OW ceiling, the OW-leg maxima
 * and the SDL figures from `sgTablesForTaxYear` — nothing is carried across
 * years except what the year modules quote from their own Table 1.
 *
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

/**
 * Board-printed dollars from a decimal string ("13200.00" → "$13,200.00"):
 * refusal text names money the way the authority prints it, not the way a
 * ledger stores it.
 */
function formatDollars(decimal: string): string {
  const [whole = "0", frac = "00"] = decimal.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
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
export function sgRatesForTaxYear(year: number): 2024 | 2025 | 2026 {
  if (!(SG_TRANSCRIBED_YEARS as readonly number[]).includes(year)) {
    throw new PayrollError(
      `the SG payroll pack has no transcribed CPF tables for ${year} — 2024, 2025 and 2026 are transcribed `
      + "(CPF Contribution Rate Table from 1 January of each year, Table 1); no other year is",
    );
  }
  return year as 2024 | 2025 | 2026;
}

/**
 * The per-year tables the engine prices from. 2026 is composed from the
 * `./rates.ts` constants it has always used (byte-identical figures);
 * 2025 and 2024 come from their own transcribed year modules.
 */
const SG_TABLES_BY_YEAR: Record<2024 | 2025 | 2026, SgYearTables> = {
  2024: SG_2024_TABLES,
  2025: SG_2025_TABLES,
  2026: {
    year: 2026,
    owCeilingMonthly: SG_OW_CEILING_MONTHLY_2026,
    cpfLe55: SG_CPF_2026_LE55,
    sdl: SG_SDL_2026,
    awCeilingAtFullOw: SG_2026_AW_CEILING_AT_FULL_OW,
  },
};

/** Select the transcribed tables for a tax year; anything else is refused by name. */
export function sgTablesForTaxYear(year: number): SgYearTables {
  return SG_TABLES_BY_YEAR[sgRatesForTaxYear(year)];
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface SgStatutoryInput {
  /** The calendar tax year selecting the CPF tables — required, never defaulted. */
  taxYear: number;
  /** Ordinary Wages for the calendar month (OW). Additional Wages ride `nonPeriodic`. */
  ordinaryWages: string;
  /** Additional Wages for the month: always refused — the AW ceiling is year-dependent. */
  additionalWages?: string | null;
  cpfStatus: SgCpfStatus;
  ageBand: SgAgeBand;
}

export interface SgStatutoryResult {
  /** False for foreigners, who are outside CPF but remain subject to SDL. */
  cpfApplicable: boolean;
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

/**
 * Refuse every status/age combination round one does not compute, by name.
 *
 * The calling year's own tables select the refusal figures: the over-55
 * bands moved in January steps (see the year modules), so a refusal citing
 * a fixed year's maxima would misstate the year's own Table 1. Callers pass
 * the same tables object the calculation prices from.
 */
export function assertSgCovered(status: SgCpfStatus, ageBand: SgAgeBand, tables: SgYearTables): void {
  if (!STATUSES.includes(status)) {
    throw new PayrollError(
      `the SG payroll pack cannot price CPF status "${status}" — declare "citizen", "spr_3rd_year", `
      + `"spr_1st_year", "spr_2nd_year" or "foreigner"`,
    );
  }
  // Foreign workers are outside CPF by statute. Their work-permit levy, if
  // any, is a separate MOM employer charge; it does not make SDL inapplicable.
  if (status === "foreigner") return;
  if (!AGE_BANDS.includes(ageBand)) {
    throw new PayrollError(
      `the SG payroll pack cannot price age band "${ageBand}" — declare "le55", "b55_60", "b60_65", `
      + `"b65_70" or "gt70"`,
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
    const le55 = tables.cpfLe55;
    throw new PayrollError(
      `the SG payroll pack refuses the "${AGE_BAND_LABELS[ageBand]}" age band by name — only the Table 1 `
      + `"55 & below" row for ${tables.year} (${le55.totalPct}% total / ${le55.employeePct}% employee, max `
      + `${formatDollars(le55.maxTotalOw)} / ${formatDollars(le55.maxEmployeeOw)}) is transcribed`,
    );
  }
}

export function calculateSgStatutory(input: SgStatutoryInput): SgStatutoryResult {
  const tables = sgTablesForTaxYear(input.taxYear);
  assertSgCovered(input.cpfStatus, input.ageBand, tables);

  const aw = parseCents(input.additionalWages ?? "0", "Additional Wages");
  if (aw > 0n) {
    // The AW ceiling is "$102,000 - Total Ordinary Wages (OW) subject to CPF
    // for the year" — a YEAR-dependent cap no per-month channel carries, so
    // any AW prices against a guessed ceiling. Refused, not approximated.
    // The refusal names the calling year's own at-full-OW ceiling, so a
    // mis-selected year is visible in the message, not just the tables.
    throw new PayrollError(
      `the SG payroll pack refuses Additional Wages of $${input.additionalWages} by name — the ${tables.year} AW ceiling `
      + `($102,000 − the year's total OW subject to CPF; ${formatDollars(tables.awCeilingAtFullOw)} at a full-OW year) depends on `
      + "year-to-date Ordinary Wages the run does not carry, and a placeholder ceiling would silently "
      + "misprice the CPF on every bonus",
    );
  }

  const cpfApplicable = input.cpfStatus !== "foreigner";
  let owSubject = 0n;
  let totalDollars = 0n;
  let employeeDollars = 0n;
  if (cpfApplicable) {
    const ow = parseCents(input.ordinaryWages, "Ordinary Wages");
    const ceiling = parseCents(tables.owCeilingMonthly, "OW ceiling");
    owSubject = ow > ceiling ? ceiling : ow;
  }

  // Table 1, 55 & below. With no AW, TW = OW and the rows price on owSubject.
  // "$50 or less: Nil / Nil". Foreigners have no CPF OW base or contribution.
  if (cpfApplicable && owSubject > 5000n) {
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
      // "> $750: [37% (OW)]*" total ("* Max. of ..." per year), "[20%
      // (OW)]*" employee ("* Max. of ..." per year). The maxima cap the OW
      // leg, which is the whole contribution with no AW. The 37%/20% row
      // shape is identical in every transcribed year (each year module
      // quotes its own Table 1); the year selects the ceiling and maxima.
      totalDollars = (owSubject * 37n + 5000n) / 10000n;
      employeeDollars = (owSubject * 20n) / 10000n;
      const maxTotal = parseCents(tables.cpfLe55.maxTotalOw, "maximum total on OW") / 100n;
      const maxEmployee = parseCents(tables.cpfLe55.maxEmployeeOw, "maximum employee share on OW") / 100n;
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
  const sdlMin = parseCents(tables.sdl.minLevy, "SDL minimum levy");
  const sdlMax = parseCents(tables.sdl.maxLevy, "SDL maximum levy");
  if (w < parseCents(tables.sdl.minWage, "SDL floor wage") && sdlCents < sdlMin) sdlCents = sdlMin;
  if (w > parseCents(tables.sdl.maxWage, "SDL cap wage") && sdlCents > sdlMax) sdlCents = sdlMax;

  return {
    cpfApplicable,
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
  CPF_APPLICABLE: "CPF contribution obligation applies",
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
      `the SG payroll pack cannot price ${P} periods per year — CPF contributions and the year's OW `
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
    taxYear,
    ordinaryWages: income,
    additionalWages: nonPeriodic,
    cpfStatus: status,
    ageBand,
  });

  if (result.cpfApplicable) {
    ctx.pushStatutory("cpf_ee", "deduction", "CPF — employee share", d4(result.employeeCents), 110);
    ctx.pushStatutory("cpf_er", "employer_contribution", "CPF — employer share", d4(result.employerCents), 210);
  }
  ctx.pushStatutory("sdl", "employer_contribution", "Skills Development Levy", d4(result.sdlCents), 220);

  return {
    CPF_APPLICABLE: result.cpfApplicable ? "true" : "false",
    ...(result.cpfApplicable ? {
      CPF_EE: d4(result.employeeCents),
      CPF_ER: d4(result.employerCents),
      CPF_TOTAL: d4(result.totalCents),
    } : {}),
    SDL: d4(result.sdlCents),
  };
}
