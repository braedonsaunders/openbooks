/**
 * Arkansas income-tax withholding — 2026 formula method.
 *
 * Source (fetched from dfa.arkansas.gov, not memory):
 *   Withholding Tax Formula Method, Effective 01/01/2026,
 *     https://www.dfa.arkansas.gov/wp-content/uploads/whformula_2026.pdf
 *     — Steps 1–6; $2,470 standard deduction; $50 midrange lookup below
 *       $100,001 (Step 2; $100,001 and over uses the exact dollar figure);
 *       printed brackets and $100 phase-down adjustments;
 *       $29.00 per AR4EC exemption; official Gary $2,127 monthly /
 *       2-exemption example ($36.50).
 *   Act 2 of the First Extraordinary Session, 2026, §1 — 3.7% rates and
 *     revised upper-income table and phase-down adjustments effective 2026.
 *   NFC Bulletin 1781190112, effective Pay Period 15, 2026 — low-income
 *     tax-credit formulas and their filing-status/exemption bands.
 *
 * Texarkana AR-TX-4EC and AR4ECSP exemption are honored as a zero
 * withholding flag. The 3.7% supplemental election is exported, not used
 * by `compute` (this engine aggregates). No city tax is invented.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, divIntCents, max0, rate6, U } from "../../canada/decimal.ts";
import { roundDiv } from "../../../money/money.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag, type PayrollCertificate,
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
const RATE6 = 1_000_000n;

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
  midrangeBelow: "100001",
  supplementalRate: pctToRate("3.7"),
};

const AR_EDITIONS_BY_YEAR: Record<number, ArYearRates> = {
  [AR_RATES_2026.year]: AR_RATES_2026,
};

export const AR_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Arkansas Act 2 of the First Extraordinary Session, 2026",
  effectiveFrom: "2026-01-01",
  citation:
    "Arkansas Act 2 of the First Extraordinary Session, 2026, §1, amending "
    + "Ark. Code §26-51-201(a)(4), effective for tax years beginning 01/01/2026; "
    + "2026 withholding formula for the $2,470 standard deduction and $29 credit",
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
 * Step 2: below $100,001, look the income up at the $50 midrange of each $100
 * range (DFA Step 2; NFC PP15 2026 concurs). The worked example maps $23,054
 * onto $23,050 (midrange of $23,000 and $23,100). $100,001 and over uses the
 * exact dollar figure. The old $97,801 cutoff was the top-bracket boundary
 * copied onto the lookup; the two cutoffs are distinct.
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
 * Act 2 §1 rates and $100 phase-down bands effective for tax years beginning
 * 01/01/2026. Above $94,700, the law applies 2% to the first $4,700 and 3.7%
 * thereafter, then subtracts its separately printed bracket adjustment.
 */
function arBracket(income: bigint): ArBracket {
  if (income <= U("5599")) return { through: "5599", rate: pctToRate("0"), adjustment: "0" };
  if (income <= U("11199")) return { through: "11199", rate: pctToRate("2"), adjustment: "111.98" };
  if (income <= U("15999")) return { through: "15999", rate: pctToRate("3"), adjustment: "223.97" };
  if (income <= U("26399")) return { through: "26399", rate: pctToRate("3.4"), adjustment: "287.97" };
  if (income <= U("94700")) return { through: "94700", rate: pctToRate("3.7"), adjustment: "367.20" };
  const statutoryAdjustment = income <= U("97600")
    ? U("290") - U("10") * BigInt((income - U("94701")) / U("100"))
    : 0n;
  return {
    through: null,
    rate: pctToRate("3.7"),
    adjustment: D(U("79.90") + statutoryAdjustment),
  };
}

/** Annual gross tax after the $50 midrange lookup and dollar rounding. */
export function arAnnualGrossTax(netTaxable: bigint, rates: ArYearRates): bigint {
  if (netTaxable <= 0n) return 0n;
  const lookedUp = arMidrangeLookup(netTaxable, rates);
  const bracket = arBracket(lookedUp);
  if (bracket.rate === pctToRate("0")) return 0n;
  const exactTax = lookedUp * rate6(bracket.rate) - U(bracket.adjustment) * RATE6;
  return roundDiv(max0(exactTax), RATE6 * DOLLAR) * DOLLAR;
}

function arLowIncomeCredit(annualWages: bigint, status: string, exemptions: number): bigint {
  let lower: bigint;
  let upper: bigint;
  let maximum: bigint;
  if (status === "single") {
    [lower, upper, maximum] = [U("14644"), U("17500"), U("111.80")];
  } else if (status === "married_joint" && exemptions <= 1) {
    [lower, upper, maximum] = [U("24696"), U("29000"), U("391.56")];
  } else if (status === "married_joint") {
    [lower, upper, maximum] = [U("29723"), U("36100"), U("531.96")];
  } else if (status === "head_household" && exemptions <= 1) {
    [lower, upper, maximum] = [U("20821"), U("25300"), U("268.84")];
  } else if (status === "head_household") {
    [lower, upper, maximum] = [U("24819"), U("29000"), U("378.04")];
  } else {
    throw new PayrollError(`AR4EC low-income election has unsupported filing status ${status}`);
  }

  if (annualWages >= upper) return 0n;
  const numerator = (upper - annualWages) * maximum;
  const creditCents = roundDiv(numerator, (upper - lower) * 100n) * 100n;
  return max0(creditCents);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = arRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new PayrollError(`invalid pay periods per year for Arkansas withholding: ${P}`);
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
  const lowIncome = certificateFlag(input.certificate, "low_income");
  const lowIncomeStatus = lowIncome ? certificateChoice(input.certificate, "filing_status") : null;
  if (lowIncome && lowIncomeStatus == null) {
    throw new PayrollError(
      "AR4EC low-income election requires the signed filing status; record the status shown on line 5 before calculating",
    );
  }
  const lowIncomeCredit = lowIncome
    ? arLowIncomeCredit(annualWages, lowIncomeStatus!, exemptions)
    : 0n;
  trace("AR_LOW_INCOME_CREDIT", lowIncomeCredit);
  const taxAfterLowIncomeCredit = max0(annualGross - lowIncomeCredit);
  const credits = U(rates.exemptionCredit) * BigInt(exemptions);
  trace("AR_PERSONAL_CREDITS", credits);
  const annualNet = max0(taxAfterLowIncomeCredit - credits);
  trace("AR_ANNUAL_NET_TAX", annualNet);

  const periodTax = divIntCents(annualNet, P);
  const additional = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  trace("AR_ADDITIONAL_WITHHOLDING", additional);
  const withheld = periodTax + additional;
  trace("AR_WITHHELD", withheld);

  return {
    state: "AR",
    year: rates.year,
    tax: D(withheld),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the DFA 2026 formula method's own (Steps 1–6) —
 * see the module header.
 */
export const AR_FACTOR_LABELS: Readonly<Record<string, string>> = {
  AR_EXEMPT: "Exempt from Arkansas withholding",
  AR_ANNUAL_WAGES: "Arkansas annualized wages",
  AR_NET_TAXABLE: "Arkansas net taxable income",
  AR_MIDRANGE: "Arkansas midrange-table amount",
  AR_ANNUAL_GROSS_TAX: "Arkansas gross tax (annual)",
  AR_LOW_INCOME_CREDIT: "Arkansas low-income tax credit (annual)",
  AR_PERSONAL_CREDITS: "Arkansas personal tax credits",
  AR_ANNUAL_NET_TAX: "Arkansas net tax (annual)",
  AR_ADDITIONAL_WITHHOLDING: "Additional Arkansas withholding per paycheck",
  AR_WITHHELD: "Arkansas tax withheld this period",
};

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
    + "withheld at zero exemptions (nothing claimed on the certificate). It also "
    + "records the low-income election and status. AR4ECSP and Texarkana "
    + "AR-TX-4EC are the exempt paths.",
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
      key: "additional_per_period",
      label: "Line 4 — Additional amount to deduct from each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      default: "0",
      help: "Optional dollar amount from Form AR4EC line 4, added after formula withholding.",
    },
    {
      key: "low_income",
      label: "Line 5 — I qualify for the low-income tax rates",
      kind: "flag",
      default: "false",
      help:
        "Record the employee's signed Yes/No election. A Yes uses the NFC low-income "
        + "tax credit formula for the elected filing status and claimed exemptions.",
    },
    {
      key: "filing_status",
      label: "Line 5 — Low-income filing status",
      kind: "choice",
      choices: [
        { value: "single", label: "Single" },
        { value: "married_joint", label: "Married Filing Jointly" },
        { value: "head_household", label: "Head of Household" },
      ],
      help:
        "Required with a low-income election. NFC's 2026 credit formula uses this "
        + "status and the AR4EC exemption count to select its income band.",
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
  // DFA Withholding Instructions: no withholding for employees who do not
  // work in Arkansas UNLESS the employee is an Arkansas resident. The Other
  // State Tax Credit (AR1000NR / Rule 1.26-51-435(c)) is return-level only —
  // no employer withholding-credit mechanism — so the full resident tax
  // is withheld.
  residentWithholding: "required",
  residentWithholdingImplemented: true,
  certificateKey: "us_ar_ar4ec",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Arkansas Act 2 of the First Extraordinary Session, 2026; "
    + "Employer's Instructions, Effective 01/01/2026; Form AR4EC",
};
