/**
 * Hawaii income-tax withholding — Booklet A annualized method.
 *
 * Source (fetched from files.hawaii.gov, not memory):
 *   Booklet A, Employer's Tax Guide (Rev. 2025) — the 2026 tables,
 *     https://files.hawaii.gov/tax/news/pubs/25BkltA.pdf
 *     — Appendix Part 1 annualized method; $1,144 regular allowance;
 *       $4,350 extra lump-sum allowance; official $500 weekly / single /
 *       3-allowance example ($9.58); no HW-4 → single, zero allowances;
 *       head of household treated as single; federal W-4 is not a substitute.
 *
 * Hawaii's payroll-update page points employers at this Rev. 2025 booklet
 * for 2026 pay dates. This engine uses that booklet; it does not invent a
 * later reprint.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";

const RATES_MODULE = "engine/src/payroll/us/states/hi.ts";

export type HiFilingStatus =
  | "single"
  | "married"
  | "married_single_rate"
  | "certified_disabled"
  | "nonresident_military_spouse";

interface HiBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface HiYearRates {
  year: number;
  status: "published" | "draft";
  allowance: string;
  lumpSumAllowance: string;
  single: readonly HiBracket[];
  married: readonly HiBracket[];
}

export const HI_RATES_2026: HiYearRates = {
  year: 2026,
  status: "published",
  allowance: "1144",
  lumpSumAllowance: "4350",
  single: [
    { over: "0", notOver: "9600", base: "0", rate: pctToRate("1.40") },
    { over: "9600", notOver: "14400", base: "134.00", rate: pctToRate("3.20") },
    { over: "14400", notOver: "19200", base: "288.00", rate: pctToRate("5.50") },
    { over: "19200", notOver: "24000", base: "552.00", rate: pctToRate("6.40") },
    { over: "24000", notOver: "36000", base: "859.00", rate: pctToRate("6.80") },
    { over: "36000", notOver: "48000", base: "1675.00", rate: pctToRate("7.20") },
    { over: "48000", notOver: "125000", base: "2539.00", rate: pctToRate("7.60") },
    { over: "125000", notOver: null, base: "8391.00", rate: pctToRate("7.90") },
  ],
  married: [
    { over: "0", notOver: "19200", base: "0", rate: pctToRate("1.40") },
    { over: "19200", notOver: "28800", base: "269.00", rate: pctToRate("3.20") },
    { over: "28800", notOver: "38400", base: "576.00", rate: pctToRate("5.50") },
    { over: "38400", notOver: "48000", base: "1104.00", rate: pctToRate("6.40") },
    { over: "48000", notOver: "72000", base: "1718.00", rate: pctToRate("6.80") },
    { over: "72000", notOver: "96000", base: "3350.00", rate: pctToRate("7.20") },
    { over: "96000", notOver: "250000", base: "5078.00", rate: pctToRate("7.60") },
    { over: "250000", notOver: null, base: "16782.00", rate: pctToRate("7.90") },
  ],
};

const HI_EDITIONS_BY_YEAR: Record<number, HiYearRates> = {
  [HI_RATES_2026.year]: HI_RATES_2026,
};

export const HI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Hawaii Booklet A Employer's Tax Guide (Rev. 2025) — 2026 tables",
  effectiveFrom: "2026-01-01",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025) "
    + "— Appendix Part 1 annualized method, $1,144 allowance, $4,350 lump-sum "
    + "allowance, $500 weekly 3-allowance example",
  status: "published",
  region: "HI",
}];

export function hiRatesForPayDate(payDate: string): HiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = HI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(HI_WITHHOLDING, year);
  }
  return rates;
}

export function hiAnnualTax(taxable: bigint, married: boolean, rates: HiYearRates): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = married ? rates.married : rates.single;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = hiRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for Hawaii withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // No HW-4: "withhold tax as if the employee was single and had claimed
  // no withholding allowance." Head of household is treated as single.
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as HiFilingStatus;
  if (status === "certified_disabled") {
    if (!certificateFlag(input.certificate, "disability_certification_on_file")) {
      throw new PayrollError(
        "Hawaii certified-disabled withholding status requires the Department-prescribed disability certification on file",
      );
    }
    factors.HI_CERTIFIED_DISABLED_NOT_SUBJECT = "1";
    return { state: "HI", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }
  if (status === "nonresident_military_spouse") {
    requireMilitarySpouseEligibility(input.certificate, "Hawaii", [
      { key: "servicemember_present_under_orders", description: "the servicemember is in Hawaii solely under military or naval orders" },
      { key: "spouse_present_to_accompany", description: "the spouse is in Hawaii solely to be with the servicemember" },
      { key: "same_non_hawaii_domicile", description: "the spouse and servicemember are domiciled in the same state outside Hawaii" },
    ]);
    factors.HI_NONRESIDENT_MILITARY_SPOUSE_NOT_SUBJECT = "1";
    return { state: "HI", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("HI_ANNUAL_WAGES", annualWages);

  const personal = U(rates.allowance) * BigInt(allowances);
  trace("HI_ALLOWANCES", personal);
  const lumpSum = U(rates.lumpSumAllowance);
  trace("HI_LUMP_SUM", lumpSum);

  const taxable = max0(annualWages - personal - lumpSum);
  trace("HI_TAXABLE", taxable);

  const annualTax = hiAnnualTax(taxable, married, rates);
  trace("HI_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  // Booklet A: "You are not required to withhold tax of less than ten cents
  // from a single wage payment."
  const withheld = total > 0n && total < U("0.10") ? 0n : total;
  trace("HI_WITHHELD", withheld);

  return {
    state: "HI",
    year: rates.year,
    tax: D(withheld),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the Booklet A annualized method's own — see the
 * module header.
 */
export const HI_FACTOR_LABELS: Readonly<Record<string, string>> = {
  HI_CERTIFIED_DISABLED_NOT_SUBJECT: "Certified-disabled wages not subject to Hawaii withholding",
  HI_NONRESIDENT_MILITARY_SPOUSE_NOT_SUBJECT:
    "Nonresident military-spouse wages not subject to Hawaii withholding",
  HI_ANNUAL_WAGES: "Hawaii annualized wages",
  HI_ALLOWANCES: "Hawaii personal allowances",
  HI_LUMP_SUM: "Hawaii lump-sum allowance",
  HI_TAXABLE: "Hawaii taxable income",
  HI_ANNUAL_TAX: "Hawaii tax (annual)",
  HI_WITHHELD: "Hawaii tax withheld this period",
};

export const HI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "HI",
  label: "Hawaii income tax",
  certificateKey: "us_hi_hw4",
  ratesModule: RATES_MODULE,
  editions: HI_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Hawaii withholding declarations — Form HW-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form HW-4, Employee's Withholding Allowance and Status Certificate. */
export const HI_CERTIFICATE: PayrollCertificate = {
  key: "us_hi_hw4",
  form: "HW-4",
  label: "Hawaii Employee's Withholding Allowance and Status Certificate",
  scope: { level: "region", region: "HI" },
  purpose: "withholding",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025); "
    + "Form HW-4 (Rev. 2022). Federal Form W-4 may not be used.",
  summary:
    "Sets Hawaii marital status, allowances, and the two HW-4 not-subject-to-withholding statuses. "
    + "Hawaii does not allow exempt status. If the employee does not "
    + "furnish an HW-4, Booklet A requires withholding as single with no "
    + "allowance. Head of household is treated as single.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Marital status for Hawaii withholding",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single (including unmarried heads of household)" },
        { value: "married", label: "Married" },
        { value: "married_single_rate", label: "Married, but withhold at the higher Single rate" },
        { value: "certified_disabled", label: "Certified disabled person (not subject to withholding)" },
        { value: "nonresident_military_spouse", label: "Nonresident military spouse (not subject to withholding)" },
      ],
      help:
        "Booklet A treats head of household as single and separately permits married employees "
        + "to choose the higher Single rate. Default Single is the publication's own rule when "
        + "no HW-4 is on file.",
    },
    {
      key: "allowances",
      label: "Number of Hawaii withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each allowance is $1,144 a year. The annualized method also subtracts "
        + "the $4,350 extra lump-sum allowance. Default zero is Booklet A's "
        + "missing-form rule (single, no allowance).",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A written agreement may withhold more than, but not less than, the "
        + "required amount. Added AFTER the annualized method is de-annualized.",
    },
    {
      key: "disability_certification_on_file",
      label: "Department-prescribed disability certification is on file",
      kind: "flag",
      help: "Required with the certified-disabled status. Hawaii requires the Department-prescribed certification that the person is blind, deaf, or totally disabled; this continues until a re-examination finds the person no longer qualifies.",
    },
    {
      key: "servicemember_present_under_orders",
      label: "Servicemember is in Hawaii solely under military or naval orders",
      kind: "flag",
      help: "Required for the nonresident military-spouse status under the Military Spouses Residency Relief Act.",
    },
    {
      key: "spouse_present_to_accompany",
      label: "Spouse is in Hawaii solely to be with the servicemember",
      kind: "flag",
      help: "Required for the nonresident military-spouse status under the Military Spouses Residency Relief Act.",
    },
    {
      key: "same_non_hawaii_domicile",
      label: "Spouse and servicemember share a domicile outside Hawaii",
      kind: "flag",
      help: "Required for the nonresident military-spouse status under the Military Spouses Residency Relief Act.",
    },
  ],
};

export const HI_REGION: PayrollRegionWithholding = {
  region: "HI",
  label: "Hawaii income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_hi_hw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Hawaii Department of Taxation, Booklet A, Employer's Tax Guide (Rev. 2025); Form HW-4",
};
