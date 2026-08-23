/**
 * Iowa income tax withholding — the four-step computer formula.
 *
 * Source (fetched from revenue.iowa.gov, not memory):
 *   Iowa Withholding Formula For Taxable Wages Paid Beginning January 1, 2026
 *     (Released November 2025)
 *     https://revenue.iowa.gov/media/53/download?inline=
 *     Four-step formula, per-period deduction tables, 3.80% flat rate, and
 *     ten worked examples. NEW for 2026: the formula and the IA W-4 were
 *     updated for federal conformity; Iowa withholds at a single 3.80% rate
 *     (not the pre-2023 bracket table).
 *   2026 IA W-4, Employee Withholding Allowance Certificate
 *     (44-019a, 11/13/2025) — https://revenue.iowa.gov/media/4324/download?inline=
 *   Form 44-016, Employee's Statement of Nonresidence in Iowa (10/3/2024) —
 *     the Illinois reciprocity certificate.
 *   Iowa Administrative Code 701—307.3(422): no IA W-4 means no allowances.
 *
 * T1 = G − D. T2 = T1 × 3.80%. T3 = T2 − (W / P). T4 = T3 + A.
 *
 * D is a printed per-period deduction keyed to the IA W-4's marital status
 * (three columns on a 2024-or-later form; two columns on a 2023-or-earlier
 * form). W on a 2024-or-later IA W-4 is a dollar amount (line 7), not a
 * headcount; on a 2023-or-earlier form it is allowances × $40.
 *
 * Frequencies the booklet prints a D for (daily/260, weekly, biweekly,
 * semimonthly, monthly, annually) use that D directly. Any other frequency
 * follows the booklet's own "Pay period not provided" rule: annualize, run
 * steps 1–3 on the annual figures, divide T3 by P, then add A.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
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

const RATES_MODULE = "engine/src/payroll/us/states/ia.ts";

type IaPeriod = "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual";

/** 2024-or-later IA W-4 deduction columns. */
export type IaDeductionColumn = "A" | "B" | "C";

export interface IaYearRates {
  year: number;
  status: "published" | "draft";
  rate: string;
  /** $40 per allowance on a 2023-or-earlier IA W-4 (Step 3B). */
  legacyAllowance: string;
  deduction2024: Readonly<Record<IaDeductionColumn, Readonly<Record<IaPeriod, string>>>>;
  /** 2023-or-earlier: (A) Single, (B) Married. */
  deductionLegacy: Readonly<Record<"A" | "B", Readonly<Record<IaPeriod, string>>>>;
}

const IA_PERIOD_BY_P: Readonly<Record<number, IaPeriod>> = {
  260: "daily",
  52: "weekly",
  26: "biweekly",
  24: "semimonthly",
  12: "monthly",
  1: "annual",
};

export const IA_RATES_2026: IaYearRates = {
  year: 2026,
  status: "published",
  rate: pctToRate("3.80"),
  legacyAllowance: "40",
  deduction2024: {
    A: {
      daily: "50.00", weekly: "250.00", biweekly: "500.00",
      semimonthly: "541.67", monthly: "1083.33", annual: "13000.00",
    },
    B: {
      daily: "75.00", weekly: "375.00", biweekly: "750.00",
      semimonthly: "812.50", monthly: "1625.00", annual: "19500.00",
    },
    C: {
      daily: "100.00", weekly: "500.00", biweekly: "1000.00",
      semimonthly: "1083.33", monthly: "2166.67", annual: "26000.00",
    },
  },
  deductionLegacy: {
    A: {
      daily: "50.00", weekly: "250.00", biweekly: "500.00",
      semimonthly: "541.67", monthly: "1083.33", annual: "13000.00",
    },
    B: {
      daily: "100.00", weekly: "500.00", biweekly: "1000.00",
      semimonthly: "1083.33", monthly: "2166.67", annual: "26000.00",
    },
  },
};

const IA_EDITIONS_BY_YEAR: Record<number, IaYearRates> = {
  [IA_RATES_2026.year]: IA_RATES_2026,
};

export const IA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Iowa Withholding Formula (November 2025), effective January 1, 2026",
  effectiveFrom: "2026-01-01",
  citation:
    "Iowa Department of Revenue, Iowa Withholding Formula For Taxable Wages Paid Beginning "
    + "January 1, 2026 (Released November 2025); 2026 IA W-4 (44-019a, 11/13/2025)",
  status: "published",
  region: "IA",
}];

export function iaRatesForPayDate(payDate: string): IaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = IA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(IA_WITHHOLDING, year);
  }
  return rates;
}

/**
 * 2024-or-later IA W-4 marital status onto columns A / B / C.
 *
 * Column A: "Other", or MFJ/QSS with spouse earned income Yes, or marital
 * status missing. Column B: Head of Household. Column C: MFJ/QSS with
 * spouse earned income No or blank. The booklet's own footnotes.
 */
export function iaColumn2024(
  filingStatus: string | null,
  spouseEarnedIncome: boolean,
): IaDeductionColumn {
  if (filingStatus === "head_household") return "B";
  if (
    (filingStatus === "married_joint" || filingStatus === "qualifying_surviving_spouse")
    && !spouseEarnedIncome
  ) {
    return "C";
  }
  return "A";
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = iaRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Iowa withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (
    certificateFlag(input.certificate, "exempt")
    || certificateFlag(input.certificate, "military_spouse_exempt")
  ) {
    return {
      state: "IA", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      factors: { IA_EXEMPT: "1" },
    };
  }

  const legacy = certificateFlag(input.certificate, "pre_2024");
  factors.IA_FORM = legacy ? "pre_2024" : "2024_or_later";

  const printed = IA_PERIOD_BY_P[P] ?? null;
  const useAnnual = printed === null;
  const formulaP = useAnnual ? 1 : P;
  const formulaPeriod: IaPeriod = useAnnual ? "annual" : printed;
  factors.IA_PERIOD = useAnnual ? `annualized/${P}` : formulaPeriod;

  let deduction: bigint;
  let allowanceAnnual: bigint;
  if (legacy) {
    const marital = certificateChoice(input.certificate, "pre_2024_marital") ?? "single";
    const column = marital === "married" ? "B" : "A";
    factors.IA_COLUMN = column;
    deduction = U(rates.deductionLegacy[column][formulaPeriod]);
    const count = certificateCount(input.certificate, "pre_2024_allowances") ?? 0;
    allowanceAnnual = U(rates.legacyAllowance) * BigInt(Math.max(count, 0));
  } else {
    const column = iaColumn2024(
      certificateChoice(input.certificate, "filing_status"),
      certificateFlag(input.certificate, "spouse_earned_income"),
    );
    factors.IA_COLUMN = column;
    deduction = U(rates.deduction2024[column][formulaPeriod]);
    allowanceAnnual = U(certificateAmount(input.certificate, "total_allowance") ?? "0");
  }
  trace("IA_DEDUCTION", deduction);
  trace("IA_ALLOWANCE_ANNUAL", allowanceAnnual);

  const periodWages = U(input.wages) + U(input.supplemental ?? "0");
  const formulaWages = useAnnual ? periodWages * BigInt(P) : periodWages;
  trace("IA_GROSS", formulaWages);

  // T1. Floored: a negative T1 would refund Iowa tax the employer never withheld.
  const t1 = max0(formulaWages - deduction);
  trace("IA_T1", t1);

  // T2.
  const t2 = mulRateCents(t1, rates.rate);
  trace("IA_T2", t2);

  // T3 = T2 − (W / P). The examples divide W by the period count and subtract
  // a cent-rounded quotient (Example 1: $40 ÷ 26 → $1.54; $60.80 − $1.54 = $59.26).
  const periodAllowance = divIntCents(allowanceAnnual, formulaP);
  const t3 = max0(t2 - periodAllowance);
  trace("IA_T3", t3);

  const periodTax = useAnnual ? divIntCents(t3, P) : t3;
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("IA_WITHHELD", total);

  return {
    state: "IA",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const IA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "IA",
  label: "Iowa income tax",
  certificateKey: "us_ia_iaw4",
  ratesModule: RATES_MODULE,
  editions: IA_TAX_YEAR_EDITIONS,
  // The booklet publishes a formula for unlisted frequencies (annualize, then
  // divide), so any P computes.
  printedPeriods: null,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Iowa withholding certificate and region declaration.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's declaration. Shape matches
 * IL_W4 / NC_NC4 / NC_REGION.
 *
 * Sources: 2026 IA W-4 (44-019a, 11/13/2025); Iowa Withholding Formula
 * (November 2025, effective January 1, 2026); Form 44-016 (10/3/2024);
 * IAC 701—307.3(422).
 */
/** 2026 IA W-4 — Employee Withholding Allowance Certificate (44-019a). */
export const IA_CERTIFICATE: PayrollCertificate = {
  key: "us_ia_iaw4",
  form: "IA W-4",
  label: "Iowa Employee Withholding Allowance Certificate",
  scope: { level: "region", region: "IA" },
  purpose: "withholding",
  citation:
    "2026 IA W-4 (44-019a, 11/13/2025); Iowa Withholding Formula For Taxable Wages Paid "
    + "Beginning January 1, 2026 (Released November 2025); IAC 701—307.3(422)",
  summary:
    "Sets Iowa withholding. IAC 701—307.3: if the employee fails to furnish a certificate, "
    + "\"the employee shall be considered as claiming no withholding allowances.\" A missing "
    + "marital status uses deduction column (A).",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status", label: "Filing status", kind: "choice",
      choices: [
        { value: "other", label: "Other (including Single)" },
        { value: "head_household", label: "Head of Household" },
        { value: "married_joint", label: "Married filing jointly" },
        { value: "qualifying_surviving_spouse", label: "Qualifying Surviving Spouse" },
      ],
      default: "other", required: true,
      help: "The 2026 formula: a missing marital status uses column (A). \"Other\" includes "
        + "single, married filing separately, and a joint filer who wants to withhold as single.",
    },
    {
      key: "spouse_earned_income",
      label: "If married filing jointly, does your spouse also have earned income?",
      kind: "flag",
      help: "Yes moves a joint filer (or qualifying surviving spouse) to column (A); No or "
        + "blank uses column (C). Ignored for Other and Head of Household.",
    },
    {
      key: "total_allowance", label: "Line 7 — Total allowances",
      kind: "amount", decimals: 4, min: "0", default: "0",
      help: "A DOLLAR amount (lines 1–6 added), not a headcount. Step 3A divides this by the "
        + "pay periods. Default zero: IAC 701—307.3.",
    },
    {
      key: "additional_per_period", label: "Line 8 — Additional amount per pay period",
      kind: "amount", decimals: 4, min: "0",
      help: "Added after the 3.80% rate — Step 4's A.",
    },
    {
      key: "exempt", label: "Exemption from withholding (enter EXEMPT)", kind: "flag",
      help: "Iowa resident, no liability last year, none expected this year. Nonresidents may "
        + "not claim this. A new IA W-4 is due by February 15 to keep the claim.",
    },
    {
      key: "military_spouse_exempt",
      label: "Military spouse (MSRRA / Veterans Benefits Acts)", kind: "flag",
      help: "Present in Iowa solely to be with a uniformed-services spouse. File with a copy "
        + "of the spousal military identification card.",
    },
    {
      key: "pre_2024", label: "Most recent IA W-4 is from 2023 or earlier", kind: "flag",
      help: "Selects Steps 1B and 3B: two deduction columns and W = allowances × $40. Leave "
        + "off for a 2024, 2025, or 2026 IA W-4.",
    },
    {
      key: "pre_2024_marital", label: "Marital status on a 2023-or-earlier IA W-4", kind: "choice",
      choices: [
        { value: "single", label: "Single (or married but legally separated)" },
        { value: "married", label: "Married" },
      ],
      default: "single",
      help: "Only read when pre_2024 is set. Missing marital status uses column (A).",
    },
    {
      key: "pre_2024_allowances", label: "Allowances claimed on a 2023-or-earlier IA W-4",
      kind: "count", min: "0", max: "99", default: "0",
      help: "Only read when pre_2024 is set. Each one is worth $40 of W.",
    },
  ],
};

/**
 * Form 44-016 — Employee's Statement of Nonresidence in Iowa (10/3/2024).
 *
 * Iowa's only reciprocal agreement is with Illinois. "You are required to have
 * a copy of this form on file for each employee who is a resident of Illinois
 * … and who claims exemption from withholding of Iowa income tax."
 */
export const IA_44016: PayrollCertificate = {
  key: "us_ia_44016",
  form: "44-016",
  label: "Employee's Statement of Nonresidence in Iowa",
  scope: { level: "region", region: "IA" },
  purpose: "non_residence",
  citation:
    "Iowa Form 44-016 (10/3/2024); Iowa Department of Revenue, Iowa–Illinois Reciprocal "
    + "Agreement (revenue.iowa.gov)",
  summary:
    "Claims exemption from Iowa withholding under the Illinois reciprocal agreement. An "
    + "Illinois resident working in Iowa is taxable only to Illinois — and only if this form "
    + "is on file. Notify the employer within ten days of a residence change.",
  storage: "certificate_rows",
  fields: [
    {
      key: "resident_state", label: "State of residence", kind: "choice",
      choices: [{ value: "IL", label: "Illinois" }],
      required: true,
      help: "Illinois is the ONLY state Iowa has a reciprocal agreement with.",
    },
  ],
};

export const IA_REGION: PayrollRegionWithholding = {
  region: "IA",
  label: "Iowa income tax",
  implemented: true,
  // IAC 701—307 and the withholding-information page: compensation paid for
  // services performed in Iowa is subject to Iowa withholding.
  taxesNonresidentWages: true,
  // NOT ESTABLISHED by the 2026 formula booklet: whether Iowa requires an
  // employer to withhold from an Iowa RESIDENT's wages earned in another
  // state. Declared unknown rather than assumed.
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ia_iaw4",
  // Iowa school-district surtax is claimed on the annual return / via extra
  // withholding on IA W-4 line 8 — the 2026 employer formula does not apply
  // a district rate.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Iowa Department of Revenue, Iowa Withholding Formula For Taxable Wages Paid Beginning "
    + "January 1, 2026 (Released November 2025); 2026 IA W-4 (44-019a, 11/13/2025)",
};
