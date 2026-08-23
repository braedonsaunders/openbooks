/**
 * Arkansas income-tax withholding — 2026 formula method.
 *
 * Source (fetched from dfa.arkansas.gov, not memory):
 *   Withholding Tax Formula Method, Effective 01/01/2026,
 *     https://www.dfa.arkansas.gov/wp-content/uploads/whformula_2026.pdf
 *     — Steps 1–6; $2,470 standard deduction; $50 midrange lookup below
 *       $97,801; printed brackets and $100 phase-down adjustments;
 *       $29.00 per AR4EC exemption; official Gary $2,127 monthly /
 *       2-exemption example ($36.50).
 *   Employer's Instructions, Effective 01/01/2026 — Form AR4EC / AR4ECSP;
 *     optional 3.9% on separately-paid supplementals; daily × 260.
 *
 * Texarkana AR-TX-4EC and AR4ECSP exemption are honored as a zero
 * withholding flag. The 3.9% supplemental election is exported, not used
 * by `compute` (this engine aggregates). No city tax is invented.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money.ts";
import {
  certificateCount, certificateFlag, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/ar.ts";
const DOLLAR = 10_000n;

export interface ArYearRates {
  year: number;
  status: "published" | "draft";
  standardDeduction: string;
  exemptionCredit: string;
  midrangeBelow: string;
  supplementalRate: string;
}

export const AR_RATES_2026: ArYearRates = {
  year: 2026,
  status: "published",
  standardDeduction: "2470",
  exemptionCredit: "29",
  midrangeBelow: "97801",
  supplementalRate: pctToRate("3.9"),
};

const AR_EDITIONS_BY_YEAR: Record<number, ArYearRates> = {
  [AR_RATES_2026.year]: AR_RATES_2026,
};

export const AR_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Arkansas Withholding Tax Formula Method, Effective 01/01/2026",
  effectiveFrom: "2026-01-01",
  citation:
    "Arkansas Department of Finance and Administration, Withholding Tax Formula "
    + "Method, Effective 01/01/2026 — Steps 1–6, $2,470 standard deduction, "
    + "$50 midrange lookup, $29 exemption credit, Gary $2,127 monthly example",
  status: "published",
  region: "AR",
}];

export function arRatesForPayDate(payDate: string): ArYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = AR_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(AR_WITHHOLDING, year);
  }
  return rates;
}

/** Round half-up to the nearest whole dollar — Step 3 "round that result". */
export function arRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/**
 * Step 2: below $97,801, look the income up at the $50 midrange of each $100
 * range. The worked example maps $23,054 onto $23,050 (midrange of $23,000
 * and $23,100). $97,801 and over uses the exact dollar figure.
 */
export function arMidrangeLookup(netTaxable: bigint, rates: ArYearRates): bigint {
  if (netTaxable >= U(rates.midrangeBelow)) return netTaxable;
  const hundred = U("100");
  return (netTaxable / hundred) * hundred + U("50");
}

interface ArBracket {
  through: string | null;
  rate: string;
  adjustment: string;
}

/**
 * Printed 2026 brackets. The $94,701–$97,800 phase-down is listed $100 at a
 * time on the publication; the adjustment falls $10.00 each band from
 * $399.30, which is what this walk reproduces.
 */
function arBracket(income: bigint): ArBracket {
  if (income <= U("5599")) return { through: "5599", rate: pctToRate("0"), adjustment: "0" };
  if (income <= U("11199")) return { through: "11199", rate: pctToRate("2"), adjustment: "111.98" };
  if (income <= U("15999")) return { through: "15999", rate: pctToRate("3"), adjustment: "223.97" };
  if (income <= U("26399")) return { through: "26399", rate: pctToRate("3.4"), adjustment: "287.97" };
  if (income <= U("94700")) return { through: "94700", rate: pctToRate("3.9"), adjustment: "419.96" };
  if (income <= U("97800")) {
    const band = Number((income - U("94701")) / U("100"));
    const adjustment = U("399.30") - U("10") * BigInt(band);
    return { through: "97800", rate: pctToRate("3.9"), adjustment: D(adjustment) };
  }
  return { through: null, rate: pctToRate("3.9"), adjustment: "89.30" };
}

/** Annual gross tax after the $50 midrange lookup and dollar rounding. */
export function arAnnualGrossTax(netTaxable: bigint, rates: ArYearRates): bigint {
  if (netTaxable <= 0n) return 0n;
  const lookedUp = arMidrangeLookup(netTaxable, rates);
  const bracket = arBracket(lookedUp);
  if (bracket.rate === pctToRate("0")) return 0n;
  return arRoundToDollar(max0(mulRateCents(lookedUp, bracket.rate) - U(bracket.adjustment)));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = arRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Arkansas withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("AR_EXEMPT", 1n);
    return { state: "AR", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualWages = wages * BigInt(P);
  trace("AR_ANNUAL_WAGES", annualWages);

  const netTaxable = max0(annualWages - U(rates.standardDeduction));
  trace("AR_NET_TAXABLE", netTaxable);
  const lookedUp = arMidrangeLookup(netTaxable, rates);
  trace("AR_MIDRANGE", lookedUp);

  const annualGross = arAnnualGrossTax(netTaxable, rates);
  trace("AR_ANNUAL_GROSS_TAX", annualGross);
  const credits = U(rates.exemptionCredit) * BigInt(exemptions);
  trace("AR_PERSONAL_CREDITS", credits);
  const annualNet = max0(annualGross - credits);
  trace("AR_ANNUAL_NET_TAX", annualNet);

  const periodTax = divIntCents(annualNet, P);
  trace("AR_WITHHELD", periodTax);

  return {
    state: "AR",
    year: rates.year,
    tax: D(periodTax),
    taxSupplemental: D(0n),
    factors,
  };
}

export const AR_WITHHOLDING: UsStateWithholdingEngine = {
  state: "AR",
  label: "Arkansas income tax",
  certificateKey: "us_ar_ar4ec",
  ratesModule: RATES_MODULE,
  editions: AR_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Arkansas withholding declarations — Form AR4EC and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form AR4EC, Employee's Withholding Exemption Certificate (2026). */
export const AR_CERTIFICATE: PayrollCertificate = {
  key: "us_ar_ar4ec",
  form: "AR4EC",
  label: "Arkansas Employee's Withholding Exemption Certificate",
  scope: { level: "region", region: "AR" },
  purpose: "withholding",
  citation:
    "Arkansas Department of Finance and Administration, Withholding Tax Formula "
    + "Method, Effective 01/01/2026; Employer's Instructions, Effective 01/01/2026; "
    + "Form AR4EC / AR4ECSP / AR-TX-4EC",
  summary:
    "Sets the number of Arkansas withholding exemptions. A missing AR4EC is "
    + "withheld at zero exemptions (nothing claimed on the certificate). AR4ECSP "
    + "and Texarkana AR-TX-4EC are the exempt paths.",
  storage: "certificate_rows",
  fields: [
    {
      key: "exemptions",
      label: "Withholding exemptions claimed on Form AR4EC",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each exemption is a $29.00 annual personal tax credit subtracted AFTER "
        + "the rounded annual gross tax. Default zero is a blank AR4EC — the "
        + "publication multiplies exemptions claimed, and none claimed is zero.",
    },
    {
      key: "exempt",
      label: "AR4ECSP or AR-TX-4EC — Exempt from Arkansas withholding",
      kind: "flag",
      help:
        "Form AR4ECSP is the special withholding exemption certificate. Form "
        + "AR-TX-4EC is the Texarkana border-city exemption. A current exempt "
        + "flag withholds zero. Dating the year-end lapse of AR-TX-4EC is "
        + "certificate administration.",
    },
  ],
};

export const AR_REGION: PayrollRegionWithholding = {
  region: "AR",
  label: "Arkansas income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ar_ar4ec",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Arkansas DFA, Withholding Tax Formula Method, Effective 01/01/2026; "
    + "Employer's Instructions, Effective 01/01/2026; Form AR4EC",
};
