/**
 * The AU pack's statutory pass for FY 2026–27 (taxYear 2027).
 *
 * Method (engine-stated, not agency-quoted — the ATO's Schedule 1
 * coefficient formulas 403 from this vantage, see ./tax-year-2027.ts):
 * annualise the period's pay (gross × periodsPerYear), compute the
 * legislated ANNUAL liability — Schedule 7 income tax, MLA section 7
 * Medicare levy, HESA Part 4-1 HELP repayment — then divide back to the
 * period, rounded half-up to the cent. The division rounding is the engine's
 * own rule; the ATO's per-period rounding is unquotable and refused by name.
 *
 * Deliberately NOT called: `assertRegionSupported`. PAYG is federal and the
 * engine computes no state's income tax, so `regions.supported` is correctly
 * [] (finding F-fr-001) while the pass itself runs for any AU region. State
 * payroll tax is an employer-aggregate levy, not PAYG — out of scope, named
 * in AU_REFUSED_2027.
 *
 * Money: bigint units (1e4) throughout, halves away from zero, via the
 * repo's money.ts — the same discipline as canada/decimal.ts.
 */
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  AU_HELP_2027,
  AU_MEDICARE_2027,
  AU_NONRESIDENT_BANDS_2027,
  AU_RESIDENT_BANDS_2027,
  AU_SUPER_2027,
  AU_WHM_BANDS_2027,
  type AuMarginalBand,
} from "./tax-year-2027.ts";

const U = (s: string | number): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT = 100n;

function rate6(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
}

/** amount × rate, exact in units (rates carry ≤2dp, units carry 4dp). */
function mulRate(u: bigint, rate: string): bigint {
  return (u * rate6(rate)) / RATE6;
}

/** Round units half-up to the cent. */
function r2(u: bigint): bigint {
  return roundDiv(u, CENT) * CENT;
}

const max0 = (u: bigint): bigint => (u < 0n ? 0n : u);
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function marginalTax(annualUnits: bigint, bands: readonly AuMarginalBand[]): bigint {
  let tax = 0n;
  for (const band of bands) {
    const lower = U(band.from);
    if (annualUnits <= lower) break;
    const upper = band.upTo === null ? annualUnits : bmin(annualUnits, U(band.upTo));
    tax += mulRate(upper - lower, band.rate);
  }
  return tax;
}

export interface Au2027Input {
  /** Annualised taxable income, decimal string. */
  annualIncome: string;
  residency: "australian_resident" | "foreign_resident";
  workingHolidayMaker: boolean;
  /** TFN declaration: threshold claimed from THIS payer (scale 2 vs 1). */
  claimsThreshold: boolean;
  tfnQuoted: boolean;
  stslDebt: boolean;
  /** Period ordinary-time earnings (qualifying-earnings proxy), decimal. */
  pensionable: string;
  periodsPerYear: number;
}

export interface Au2027Result {
  /** Period PAYG withholding (income tax + Medicare + HELP), 4dp string. */
  payg: string;
  /** Period Super Guarantee accrual (employer), 4dp string. */
  sg: string;
}

export function calculateAu2027(input: Au2027Input): Au2027Result {
  if (!input.tfnQuoted) {
    throw new PayrollPackError(
      "AU PAYG withholding with no quoted TFN is refused by name: the no-TFN "
      + "rate lives in Taxation Administration Act Schedule 1 on the same "
      + "403ing host (see AU_REFUSED_2027)",
    );
  }
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new PayrollPackError(
      `AU PAYG annualisation needs a positive integer periodsPerYear, got ${input.periodsPerYear}`,
    );
  }
  const annual = U(input.annualIncome);
  if (annual < 0n) {
    throw new PayrollPackError(
      `AU PAYG annualisation needs non-negative income, got ${input.annualIncome}`,
    );
  }

  const bands = input.workingHolidayMaker
    ? AU_WHM_BANDS_2027
    : input.residency === "australian_resident"
      ? AU_RESIDENT_BANDS_2027
      : AU_NONRESIDENT_BANDS_2027;
  // Scale-1 effect (engine-stated): withholding without a threshold claim
  // does not apply the $18,200 tax-free threshold; the 15% band starts at $0.
  const applied = input.residency === "australian_resident"
      && !input.workingHolidayMaker
      && !input.claimsThreshold
    ? [{ from: "0", upTo: bands[0]!.upTo, rate: bands[0]!.rate }, ...bands.slice(1)]
    : bands;
  const incomeTax = marginalTax(annual, applied);

  // Medicare and HELP are computed for Australian residents only. Foreign
  // residents and working holiday makers are outside the modelled scope:
  // levy liability turns on Part VIIB of the Assessment Act 1936
  // (entitlement/exemption rules), which is not transcribed — refused by name.
  const medicareResident = input.residency === "australian_resident"
    && !input.workingHolidayMaker;
  const threshold = U(AU_MEDICARE_2027.threshold);
  const phaseIn = U(AU_MEDICARE_2027.phaseInLimit);
  const fullLevy = mulRate(annual, AU_MEDICARE_2027.rate);
  const medicare = !medicareResident
    ? 0n
    : annual <= threshold
      ? 0n
      : annual <= phaseIn
        ? bmin(fullLevy, mulRate(annual - threshold, AU_MEDICARE_2027.shadeRate))
        : fullLevy;

  // HESA 154-1(2): no HELP where the Medicare levy is exempt or reduced.
  // Repayment income is proxied by taxable income (154-5 extras unseen).
  let help = 0n;
  if (input.stslDebt && medicareResident && medicare >= fullLevy && annual > 0n) {
    const minimum = U(AU_HELP_2027.minimumIncome);
    const secondCap = U(AU_HELP_2027.secondBandCap);
    help = mulRate(max0(bmin(annual, secondCap) - minimum), AU_HELP_2027.firstRate)
      + mulRate(max0(annual - secondCap), AU_HELP_2027.secondRate);
    help = bmin(help, mulRate(annual, AU_HELP_2027.incomeCapRate));
  }

  // Super Guarantee: 12% of period qualifying earnings (SGAA 17A(2)). No
  // annual maximum-contributions-base cap: the 2026–27 concessional-cap
  // input is refused by name (see AU_REFUSED_2027).
  const sg = r2(mulRate(U(input.pensionable), AU_SUPER_2027.chargeRate));
  const paygAnnual = incomeTax + medicare + help;
  const paygPeriod = r2(roundDiv(paygAnnual, BigInt(input.periodsPerYear) * CENT) * CENT);
  return { payg: D(paygPeriod), sg: D(sg) };
}

export async function computeAuStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    taxYear, income, pensionable, periodsPerYear,
    pushStatutory, certificateFor, bool,
  } = ctx;
  if (taxYear !== 2027) {
    throw new PayrollPackError(
      `AU PAYG withholding for tax year ${taxYear} has not been transcribed `
      + "— the AU payroll pack's only transcribed edition is 2026–27 "
      + "(taxYear 2027; see tax-year-2027.ts). Transcribe the year's "
      + "legislation before calculating",
    );
  }
  const tfn = certificateFor("au_tfn_declaration");
  const answers = tfn?.answers ?? {};
  const residency = answers["residency"] ?? "australian_resident";
  if (residency !== "australian_resident" && residency !== "foreign_resident") {
    throw new PayrollPackError(
      `AU TFN declaration residency answer "${residency}" is not a declared choice`,
    );
  }
  const annualIncome = D(U(income) * BigInt(periodsPerYear));
  const result = calculateAu2027({
    annualIncome,
    residency,
    workingHolidayMaker: bool(answers["working_holiday_maker"] ?? null),
    claimsThreshold: bool(answers["tax_free_threshold"] ?? null),
    tfnQuoted: (answers["tax_file_number"] ?? "") !== "",
    stslDebt: bool(answers["stsl_debt"] ?? null),
    pensionable,
    periodsPerYear,
  });
  pushStatutory("payg_withholding", "deduction", "PAYG withholding", result.payg, 110);
  pushStatutory(
    "super_guarantee",
    "employer_contribution",
    "Superannuation guarantee",
    result.sg,
    210,
  );
  return { I: income, PI: pensionable };
}
