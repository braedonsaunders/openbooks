/**
 * Kansas income-tax withholding — KW-100 percentage formula.
 *
 * Source (fetched from ksrevenue.gov, not memory):
 *   KW-100, Withholding Tax Guide (Rev. 7-24 / 10-24), live official,
 *     https://ksrevenue.gov/pdf/kw100.pdf
 *     — $9,160 single / HoH / MFS personal exemption; $18,320 married-joint
 *       (two $9,160s); $2,320 per additional dependent allowance; official
 *       Esmeralda Espinoza $2,000 semi-monthly / married / 3-allowance
 *       example ($41.44); missing K-4 → single, zero allowances.
 *   TABLES FOR PERCENTAGE METHOD OF KANSAS WITHHOLDING
 *     (wages paid on and after July 1, 2024),
 *     https://ksrevenue.gov/pdf/whrates.pdf
 *
 * Rounding of the percentage result is optional in KW-100 ("may be rounded").
 * This engine keeps the publication's own unrounded $41.44 golden.
 *
 * Flat 5% separately-paid supplemental / miscellaneous percentage withholding
 * is exported, not used by `compute` (this engine aggregates).
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
  type PayrollCertificate,
} from "../../certificates.ts";
import type { PayrollRegionWithholding } from "../../withholding-jurisdictions.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/ks.ts";

export type KsPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

export type KsFilingStatus = "single" | "married";

const KS_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

interface KsBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

export interface KsPeriodTable {
  marriedJoint: string;
  single: string;
  dependent: string;
  singleBrackets: readonly KsBracket[];
  marriedBrackets: readonly KsBracket[];
}

const P52 = pctToRate("5.2");
const P558 = pctToRate("5.58");

/**
 * Printed KW-100 withholding-allowance amounts and percentage-method tables.
 * Allowance columns are the publication's own per-period figures, not a
 * re-division of the annual exemptions.
 */
export const KS_TABLES: Readonly<Record<KsPeriod, KsPeriodTable>> = {
  weekly: {
    marriedJoint: "352.31", single: "176.15", dependent: "44.62",
    singleBrackets: [
      { over: "0", notOver: "69", base: "0", rate: pctToRate("0") },
      { over: "69", notOver: "512", base: "0", rate: P52 },
      { over: "512", notOver: null, base: "23.00", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "158", base: "0", rate: pctToRate("0") },
      { over: "158", notOver: "1043", base: "0", rate: P52 },
      { over: "1043", notOver: null, base: "46.00", rate: P558 },
    ],
  },
  biweekly: {
    marriedJoint: "704.62", single: "352.31", dependent: "89.23",
    singleBrackets: [
      { over: "0", notOver: "139", base: "0", rate: pctToRate("0") },
      { over: "139", notOver: "1023", base: "0", rate: P52 },
      { over: "1023", notOver: null, base: "46.00", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "317", base: "0", rate: pctToRate("0") },
      { over: "317", notOver: "2086", base: "0", rate: P52 },
      { over: "2086", notOver: null, base: "92.00", rate: P558 },
    ],
  },
  semimonthly: {
    marriedJoint: "763.33", single: "381.67", dependent: "96.67",
    singleBrackets: [
      { over: "0", notOver: "150", base: "0", rate: pctToRate("0") },
      { over: "150", notOver: "1109", base: "0", rate: P52 },
      { over: "1109", notOver: null, base: "49.83", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "343", base: "0", rate: pctToRate("0") },
      { over: "343", notOver: "2260", base: "0", rate: P52 },
      { over: "2260", notOver: null, base: "99.67", rate: P558 },
    ],
  },
  monthly: {
    marriedJoint: "1526.67", single: "763.33", dependent: "193.33",
    singleBrackets: [
      { over: "0", notOver: "300", base: "0", rate: pctToRate("0") },
      { over: "300", notOver: "2217", base: "0", rate: P52 },
      { over: "2217", notOver: null, base: "99.67", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "687", base: "0", rate: pctToRate("0") },
      { over: "687", notOver: "4520", base: "0", rate: P52 },
      { over: "4520", notOver: null, base: "199.33", rate: P558 },
    ],
  },
  quarterly: {
    marriedJoint: "4580.00", single: "2290.00", dependent: "580.00",
    singleBrackets: [
      { over: "0", notOver: "901", base: "0", rate: pctToRate("0") },
      { over: "901", notOver: "6651", base: "0", rate: P52 },
      { over: "6651", notOver: null, base: "299.00", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "2060", base: "0", rate: pctToRate("0") },
      { over: "2060", notOver: "13560", base: "0", rate: P52 },
      { over: "13560", notOver: null, base: "598.00", rate: P558 },
    ],
  },
  semiannual: {
    marriedJoint: "9160.00", single: "4580.00", dependent: "1160.00",
    singleBrackets: [
      { over: "0", notOver: "1803", base: "0", rate: pctToRate("0") },
      { over: "1803", notOver: "13303", base: "0", rate: P52 },
      { over: "13303", notOver: null, base: "598.00", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "4120", base: "0", rate: pctToRate("0") },
      { over: "4120", notOver: "27120", base: "0", rate: P52 },
      { over: "27120", notOver: null, base: "1196.00", rate: P558 },
    ],
  },
  annual: {
    marriedJoint: "18320.00", single: "9160.00", dependent: "2320.00",
    singleBrackets: [
      { over: "0", notOver: "3605", base: "0", rate: pctToRate("0") },
      { over: "3605", notOver: "26605", base: "0", rate: P52 },
      { over: "26605", notOver: null, base: "1196.00", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "8240", base: "0", rate: pctToRate("0") },
      { over: "8240", notOver: "54240", base: "0", rate: P52 },
      { over: "54240", notOver: null, base: "2392.00", rate: P558 },
    ],
  },
  daily: {
    marriedJoint: "70.46", single: "35.23", dependent: "8.92",
    singleBrackets: [
      { over: "0", notOver: "14", base: "0", rate: pctToRate("0") },
      { over: "14", notOver: "102", base: "0", rate: P52 },
      { over: "102", notOver: null, base: "4.60", rate: P558 },
    ],
    marriedBrackets: [
      { over: "0", notOver: "32", base: "0", rate: pctToRate("0") },
      { over: "32", notOver: "209", base: "0", rate: P52 },
      { over: "209", notOver: null, base: "9.20", rate: P558 },
    ],
  },
};

export interface KsYearRates {
  year: number;
  status: "published" | "draft";
  supplementalRate: string;
}

export const KS_RATES_2026: KsYearRates = {
  year: 2026,
  status: "published",
  supplementalRate: pctToRate("5"),
};

const KS_EDITIONS_BY_YEAR: Record<number, KsYearRates> = {
  [KS_RATES_2026.year]: KS_RATES_2026,
};

export const KS_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Kansas KW-100 Withholding Tax Guide (Rev. 7-24) — rates on or after July 1, 2024",
  effectiveFrom: "2026-01-01",
  citation:
    "Kansas Department of Revenue, KW-100 Withholding Tax Guide (live official) "
    + "— percentage formula, $9,160 / $18,320 / $2,320 allowances, Esmeralda "
    + "Espinoza $2,000 semi-monthly married 3-allowance example ($41.44)",
  status: "published",
  region: "KS",
}];

export function ksRatesForPayDate(payDate: string): KsYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = KS_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(KS_WITHHOLDING, year);
  }
  return rates;
}

/**
 * KW-100 Step 1: Joint treats the first two allowances as the $18,320 personal
 * exemption (Esmeralda); Single treats the first allowance as the $9,160
 * personal exemption. Each remaining allowance is the $2,320 dependent column.
 */
export function ksAllowance(period: KsPeriod, married: boolean, allowances: number): bigint {
  if (allowances <= 0) return 0n;
  const table = KS_TABLES[period];
  if (married) {
    if (allowances >= 2) {
      return U(table.marriedJoint) + U(table.dependent) * BigInt(allowances - 2);
    }
    return U(table.single);
  }
  return U(table.single) + U(table.dependent) * BigInt(allowances - 1);
}

export function ksPeriodTax(taxable: bigint, period: KsPeriod, married: boolean): bigint {
  if (taxable <= 0n) return 0n;
  const brackets = married ? KS_TABLES[period].marriedBrackets : KS_TABLES[period].singleBrackets;
  let chosen = brackets[0]!;
  for (const bracket of brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  if (chosen.rate === pctToRate("0")) return 0n;
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ksRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !KS_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(KS_WITHHOLDING, input.periodsPerYear);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("KS_EXEMPT", 1n);
    return { state: "KS", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Missing K-4: "the employer must withhold wages at the single rate with no
  // allowances."
  const status = (certificateChoice(input.certificate, "filing_status") ?? "single") as KsFilingStatus;
  const married = status === "married";
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("KS_WAGES", wages);

  const allowance = ksAllowance(period, married, allowances);
  trace("KS_ALLOWANCE", allowance);
  const taxable = max0(wages - allowance);
  trace("KS_TAXABLE", taxable);

  const periodTax = ksPeriodTax(taxable, period, married);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("KS_WITHHELD", total);

  return {
    state: "KS",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const KS_WITHHOLDING: UsStateWithholdingEngine = {
  state: "KS",
  label: "Kansas income tax",
  certificateKey: "us_ks_k4",
  ratesModule: RATES_MODULE,
  editions: KS_TAX_YEAR_EDITIONS,
  printedPeriods: KS_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Kansas withholding declarations — Form K-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form K-4, Kansas Employee's Withholding Allowance Certificate (Rev. 7-24). */
export const KS_CERTIFICATE: PayrollCertificate = {
  key: "us_ks_k4",
  form: "K-4",
  label: "Kansas Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "KS" },
  purpose: "withholding",
  citation:
    "Kansas Department of Revenue, KW-100 Withholding Tax Guide (live official); "
    + "Form K-4 (Rev. 7-24)",
  summary:
    "Sets the K-4 allowance rate (Single or Joint) and the total number of "
    + "Kansas withholding allowances. If the employee does not complete a K-4, "
    + "KW-100 requires withholding at the single rate with no allowances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Line 3 — Allowance rate",
      kind: "choice",
      default: "single",
      choices: [
        {
          value: "single",
          label: "Single (including head of household, or married whose spouse has income)",
        },
        { value: "married", label: "Joint — married and spouse has no income" },
      ],
      help:
        "K-4 Line A / Line 3. Joint uses the Married percentage table and the "
        + "$18,320 personal exemption. Single uses the Single table and the "
        + "$9,160 personal exemption. Default Single is KW-100's missing-form rule.",
    },
    {
      key: "allowances",
      label: "Line 4 — Total number of Kansas withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "From the K-4 Personal Allowance Worksheet line F. Joint treats the "
        + "first two allowances as the $18,320 married-joint exemption; Single "
        + "treats the first as the $9,160 exemption. Each remaining allowance "
        + "is the $2,320 dependent amount. Default zero is KW-100's missing-form rule.",
    },
    {
      key: "additional_per_period",
      label: "Line 5 — Additional amount to withhold each paycheck",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "Optional extra Kansas withholding requested on Form K-4. Added AFTER "
        + "the percentage formula. The amounts in KW-100 are the minimum.",
    },
    {
      key: "exempt",
      label: "Line 6 — Exempt from Kansas withholding",
      kind: "flag",
      help:
        "A federal withholding exemption also exempts Kansas withholding. A "
        + "current Exempt on K-4 line 6 withholds zero. Exemption from "
        + "withholding is not an exemption from filing a Kansas return.",
    },
  ],
};

export const KS_REGION: PayrollRegionWithholding = {
  region: "KS",
  label: "Kansas income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ks_k4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Kansas Department of Revenue, KW-100 Withholding Tax Guide (live official); Form K-4",
};
