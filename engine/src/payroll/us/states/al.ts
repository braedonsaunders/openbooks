/**
 * Alabama income-tax withholding — ALDOR formula method.
 *
 * Source (fetched from revenue.alabama.gov, not memory):
 *   Withholding Tax Tables and Instructions for Employers and Withholding
 *     Agents, Revised August 2024,
 *     https://www.revenue.alabama.gov/wp-content/uploads/2024/10/whbooklet_1024.pdf
 *     — Formula For Computing Alabama Withholding Tax, lines 1–6; Schedule
 *       of Standard Deduction Amounts (the printed phase-out); official
 *       M-2 / $850 weekly example; no A-4 → zero exemptions; optional 5%
 *       on separately-paid supplementals.
 *   Ala. Admin. Code r. 810-3-71-.02 — A-4 codes 0 / S / M / H / MS.
 *
 * The August 2024 booklet is the live official publication. 2026 pay dates
 * use that formula; they do not invent a January 2026 reprint.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/al.ts";

export type AlExemption = "0" | "S" | "MS" | "M" | "H";

export interface AlYearRates {
  year: number;
  status: "published" | "draft";
  supplementalRate: string;
}

export const AL_RATES_2026: AlYearRates = {
  year: 2026,
  status: "published",
  supplementalRate: pctToRate("5"),
};

const AL_EDITIONS_BY_YEAR: Record<number, AlYearRates> = {
  [AL_RATES_2026.year]: AL_RATES_2026,
};

export const AL_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "ALDOR withholding formula (booklet Revised August 2024)",
  effectiveFrom: "2026-01-01",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024 — formula lines 1–6, "
    + "standard-deduction phase-out, M-2 $850 weekly example; Form A-4",
  status: "published",
  region: "AL",
}];

export function alRatesForPayDate(payDate: string): AlYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = AL_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(AL_WITHHOLDING, year);
  }
  return rates;
}

/** "less $X for each $step increment or part thereof of GI above the first ceiling." */
function phasedDeduction(
  gi: bigint,
  firstUpTo: string,
  firstAmount: string,
  floorFrom: string,
  floorAmount: string,
  step: string,
  reduction: string,
): bigint {
  if (gi <= U(firstUpTo)) return U(firstAmount);
  if (gi >= U(floorFrom)) return U(floorAmount);
  const excess = gi - U(firstUpTo);
  const steps = (excess + U(step) - 1n) / U(step);
  return max0(U(firstAmount) - steps * U(reduction));
}

export function alStandardDeduction(exemption: AlExemption, gi: bigint): bigint {
  if (exemption === "0" || exemption === "S") {
    return phasedDeduction(gi, "25999", "3000", "35500", "2500", "500", "25");
  }
  if (exemption === "MS") {
    return phasedDeduction(gi, "12999", "4250", "17750", "2500", "250", "88");
  }
  if (exemption === "M") {
    return phasedDeduction(gi, "25999", "8500", "35500", "5000", "500", "175");
  }
  return phasedDeduction(gi, "25999", "5200", "35500", "2500", "500", "135");
}

export function alPersonalExemption(exemption: AlExemption): bigint {
  if (exemption === "0") return 0n;
  if (exemption === "S" || exemption === "MS") return U("1500");
  return U("3000");
}

export function alDependentAllowance(gi: bigint, dependents: number): bigint {
  const per = gi <= U("50000") ? U("1000") : gi <= U("100000") ? U("500") : U("300");
  return per * BigInt(dependents < 0 ? 0 : dependents);
}

/** Line 5. Only "M" uses the doubled brackets. */
export function alAnnualTax(exemption: AlExemption, taxable: bigint): bigint {
  if (exemption === "M") {
    const first = mulRateCents(bmin(taxable, U("1000")), pctToRate("2"));
    const second = mulRateCents(bmin(max0(taxable - U("1000")), U("5000")), pctToRate("4"));
    const rest = mulRateCents(max0(taxable - U("6000")), pctToRate("5"));
    return first + second + rest;
  }
  const first = mulRateCents(bmin(taxable, U("500")), pctToRate("2"));
  const second = mulRateCents(bmin(max0(taxable - U("500")), U("2500")), pctToRate("4"));
  const rest = mulRateCents(max0(taxable - U("3000")), pctToRate("5"));
  return first + second + rest;
}

function bmin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function alSupplementalFlat(supplemental: string, rates: AlYearRates = AL_RATES_2026): string {
  return D(mulRateCents(U(supplemental), rates.supplementalRate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = alRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Alabama withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const code = (certificateChoice(input.certificate, "exemption") ?? "0") as AlExemption;
  if (code !== "0" && code !== "S" && code !== "MS" && code !== "M" && code !== "H") {
    throw new Error(`Alabama exemption "${code}" is not 0, S, MS, M, or H`);
  }
  const dependents = certificateCount(input.certificate, "dependents") ?? 0;
  const periodFederal = certificateAmount(input.certificate, "federal_income_tax_withheld");
  if (periodFederal == null) {
    throw new Error(
      "Alabama withholding (ALDOR formula line 2B) requires this period's federal "
      + "income tax withheld. The engine will not assume $0.",
    );
  }

  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const gi = wages * BigInt(P);
  trace("AL_GI", gi);

  const standard = alStandardDeduction(code, gi);
  trace("AL_STANDARD_DEDUCTION", standard);
  const federal = U(periodFederal) * BigInt(P);
  trace("AL_FEDERAL_ANNUAL", federal);
  const personal = alPersonalExemption(code);
  trace("AL_PERSONAL_EXEMPTION", personal);
  const deps = alDependentAllowance(gi, dependents);
  trace("AL_DEPENDENTS", deps);

  const deductions = standard + federal + personal + deps;
  trace("AL_DEDUCTIONS", deductions);
  const taxable = max0(gi - deductions);
  trace("AL_TAXABLE", taxable);

  const annualTax = alAnnualTax(code, taxable);
  trace("AL_ANNUAL_TAX", annualTax);
  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("AL_WITHHELD", total);

  return {
    state: "AL",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const AL_WITHHOLDING: UsStateWithholdingEngine = {
  state: "AL",
  label: "Alabama income tax",
  certificateKey: "us_al_a4",
  ratesModule: RATES_MODULE,
  editions: AL_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Alabama withholding declarations — Form A-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form A-4, Employee's Withholding Exemption Certificate. */
export const AL_CERTIFICATE: PayrollCertificate = {
  key: "us_al_a4",
  form: "A-4",
  label: "Employee's Withholding Exemption Certificate (Alabama)",
  scope: { level: "region", region: "AL" },
  purpose: "withholding",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024; Form A-4; Ala. Admin. "
    + "Code r. 810-3-71-.02",
  summary:
    "Sets the Alabama withholding exemption (0, S, MS, M, H) and dependents. "
    + "Federal Form W-4 is not an acceptable substitute. If an employee fails to "
    + "furnish Form A-4, the employer withholds using zero exemptions.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemption",
      label: "Withholding exemption (Form A-4)",
      kind: "choice",
      default: "0",
      choices: [
        { value: "0", label: "0 — no personal exemption" },
        { value: "S", label: "S — single personal exemption ($1,500)" },
        { value: "MS", label: "MS — married filing separately ($1,500)" },
        { value: "M", label: "M — married filing jointly ($3,000)" },
        { value: "H", label: "H — head of family ($3,000)" },
      ],
      help:
        "Default 0 is ALDOR's own rule when no A-4 is on file. H uses the head-of-family "
        + "standard deduction and the 0/S/MS tax brackets. M is the only status that "
        + "uses the doubled brackets.",
    },
    {
      key: "dependents",
      label: "Dependents other than spouse",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each dependent is $1,000 / $500 / $300 a year depending on annualized GI "
        + "(≤ $50,000 / ≤ $100,000 / above). Not the spouse — M already covers both "
        + "personal exemptions.",
    },
    {
      key: "federal_income_tax_withheld",
      label: "Federal income tax withheld this period (formula line 2B)",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Not an A-4 line. The formula subtracts this period's federal withholding "
        + "annualized. A missing amount is refused — assuming zero would over-withhold. "
        + "Do not include FICA.",
    },
    {
      key: "additional_per_period",
      label: "Additional Alabama withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help: "Added AFTER the formula is de-annualized. A flat dollar amount.",
    },
  ],
};

export const AL_REGION: PayrollRegionWithholding = {
  region: "AL",
  label: "Alabama income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_al_a4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Alabama Department of Revenue, Withholding Tax Tables and Instructions for "
    + "Employers and Withholding Agents, Revised August 2024; Ala. Admin. Code r. 810-3-71-.02",
};
