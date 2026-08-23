/**
 * Rhode Island income-tax withholding — 2026 percentage method.
 *
 * Source (fetched from tax.ri.gov, not memory):
 *   2026 Rhode Island Employer's Income Tax Withholding Tables,
 *     https://tax.ri.gov/sites/g/files/xkgbur541/files/2025-11/2026%20Withholding%20Tax%20Booklet_d.pdf
 *     — percentage-method exemption amounts; eight printed period tables;
 *       official $2,195 weekly / 1-exemption example ($87.57); exemption
 *       phases to zero when period wages exceed $290,800 annualized;
 *       supplemental rate 5.99% when paid separately.
 *
 * The November 2025 posting still carries a DRAFT watermark. It is the
 * booklet tax.ri.gov currently publishes as the 2026 tables; 2026 pay dates
 * use that booklet and do not invent a later reprint.
 *
 * This is a per-period TABLE method. An unpublished frequency is refused.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateCount, certificateFlag, type PayrollCertificate,
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

const RATES_MODULE = "engine/src/payroll/us/states/ri.ts";

export type RiPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const RI_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

interface RiBracket {
  over: string;
  notOver: string | null;
  base: string;
  rate: string;
}

interface RiPeriodTable {
  exemption: string;
  phaseOutAbove: string;
  brackets: readonly RiBracket[];
}

const R3 = pctToRate("3.75");
const R4 = pctToRate("4.75");
const R5 = pctToRate("5.99");

const RI_TABLES_2026: Record<RiPeriod, RiPeriodTable> = {
  weekly: {
    exemption: "19.23",
    phaseOutAbove: "5592.31",
    brackets: [
      { over: "0", notOver: "1578", base: "0", rate: R3 },
      { over: "1578", notOver: "3586", base: "59.18", rate: R4 },
      { over: "3586", notOver: null, base: "154.56", rate: R5 },
    ],
  },
  biweekly: {
    exemption: "38.46",
    phaseOutAbove: "11184.62",
    brackets: [
      { over: "0", notOver: "3156", base: "0", rate: R3 },
      { over: "3156", notOver: "7171", base: "118.35", rate: R4 },
      { over: "7171", notOver: null, base: "309.06", rate: R5 },
    ],
  },
  semimonthly: {
    exemption: "41.67",
    phaseOutAbove: "12116.67",
    brackets: [
      { over: "0", notOver: "3419", base: "0", rate: R3 },
      { over: "3419", notOver: "7769", base: "128.21", rate: R4 },
      { over: "7769", notOver: null, base: "334.84", rate: R5 },
    ],
  },
  monthly: {
    exemption: "83.33",
    phaseOutAbove: "24233.33",
    brackets: [
      { over: "0", notOver: "6838", base: "0", rate: R3 },
      { over: "6838", notOver: "15538", base: "256.43", rate: R4 },
      { over: "15538", notOver: null, base: "669.68", rate: R5 },
    ],
  },
  quarterly: {
    exemption: "250.00",
    phaseOutAbove: "72700.00",
    brackets: [
      { over: "0", notOver: "20513", base: "0", rate: R3 },
      { over: "20513", notOver: "46613", base: "769.24", rate: R4 },
      { over: "46613", notOver: null, base: "2008.99", rate: R5 },
    ],
  },
  semiannual: {
    exemption: "500.00",
    phaseOutAbove: "145400.00",
    brackets: [
      { over: "0", notOver: "41025", base: "0", rate: R3 },
      { over: "41025", notOver: "93225", base: "1538.44", rate: R4 },
      { over: "93225", notOver: null, base: "4017.94", rate: R5 },
    ],
  },
  annual: {
    exemption: "1000.00",
    phaseOutAbove: "290800.00",
    brackets: [
      { over: "0", notOver: "82050", base: "0", rate: R3 },
      { over: "82050", notOver: "186450", base: "3076.88", rate: R4 },
      { over: "186450", notOver: null, base: "8035.88", rate: R5 },
    ],
  },
  daily: {
    exemption: "3.85",
    phaseOutAbove: "1118.46",
    brackets: [
      { over: "0", notOver: "315.58", base: "0", rate: R3 },
      { over: "315.58", notOver: "717.12", base: "11.83", rate: R4 },
      { over: "717.12", notOver: null, base: "30.90", rate: R5 },
    ],
  },
};

export interface RiYearRates {
  year: number;
  status: "published" | "draft";
  supplementalRate: string;
}

export const RI_RATES_2026: RiYearRates = {
  year: 2026,
  status: "published",
  supplementalRate: R5,
};

const RI_EDITIONS_BY_YEAR: Record<number, RiYearRates> = {
  [RI_RATES_2026.year]: RI_RATES_2026,
};

export const RI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "2026 Rhode Island Employer's Income Tax Withholding Tables",
  effectiveFrom: "2026-01-01",
  citation:
    "Rhode Island Division of Taxation, 2026 Employer's Income Tax Withholding "
    + "Tables — percentage-method exemption amounts, eight period tables, "
    + "$2,195 weekly 1-exemption example",
  status: "published",
  region: "RI",
}];

export function riRatesForPayDate(payDate: string): RiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = RI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(RI_WITHHOLDING, year);
  }
  return rates;
}

export function riPeriodTable(period: RiPeriod): RiPeriodTable {
  return RI_TABLES_2026[period];
}

export function riPeriodTax(taxable: bigint, period: RiPeriod): bigint {
  if (taxable <= 0n) return 0n;
  const table = RI_TABLES_2026[period];
  let chosen = table.brackets[0]!;
  for (const bracket of table.brackets) {
    if (taxable > U(bracket.over)) chosen = bracket;
  }
  return U(chosen.base) + mulRateCents(taxable - U(chosen.over), chosen.rate);
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = riRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (!period || !RI_PERIODS.includes(period) || (period === "daily" && input.periodsPerYear !== 260)) {
    refuseUnprintedPeriod(RI_WITHHOLDING, input.periodsPerYear);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    trace("RI_EXEMPT", 1n);
    return { state: "RI", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const table = RI_TABLES_2026[period];
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("RI_WAGES", wages);

  const exemption = wages > U(table.phaseOutAbove)
    ? 0n
    : U(table.exemption) * BigInt(allowances);
  trace("RI_EXEMPTION", exemption);
  const taxable = max0(wages - exemption);
  trace("RI_TAXABLE", taxable);

  const periodTax = riPeriodTax(taxable, period);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("RI_WITHHELD", total);

  return {
    state: "RI",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const RI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "RI",
  label: "Rhode Island income tax",
  certificateKey: "us_ri_riw4",
  ratesModule: RATES_MODULE,
  editions: RI_TAX_YEAR_EDITIONS,
  printedPeriods: RI_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * Rhode Island withholding declarations — Form RI W-4 and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/** Form RI W-4, Employee's Withholding Allowance Certificate for 2026. */
export const RI_CERTIFICATE: PayrollCertificate = {
  key: "us_ri_riw4",
  form: "RI W-4",
  label: "Rhode Island Employee's Withholding Allowance Certificate",
  scope: { level: "region", region: "RI" },
  purpose: "withholding",
  citation:
    "Rhode Island Division of Taxation, 2026 Employer's Income Tax Withholding "
    + "Tables; Form RI W-4 (2026). Federal Form W-4 can no longer be used for "
    + "Rhode Island withholding.",
  summary:
    "Sets Rhode Island allowances. A missing RI W-4 is withheld at zero "
    + "allowances. Annual wages over $290,800 phase the exemption to zero.",
  storage: "certificate_rows",
  fields: [
    {
      key: "allowances",
      label: "Line 1 — Total number of Rhode Island withholding allowances",
      kind: "count",
      min: "0",
      max: "99",
      default: "0",
      help:
        "Each weekly allowance is $19.23 (the booklet's other frequencies scale "
        + "the same $1,000 annual exemption). Default zero is a blank RI W-4 — "
        + "nothing claimed is zero. Federal Form W-4 is not a substitute.",
    },
    {
      key: "additional_per_period",
      label: "Additional amount to withhold each pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "A flat dollar amount requested on Form RI W-4. Added AFTER the "
        + "percentage-method table is applied to this period's wages.",
    },
    {
      key: "exempt",
      label: "Line 3 — Exempt or Exempt-MS from Rhode Island withholding",
      kind: "flag",
      help:
        "EXEMPT and EXEMPT-MS on line 3 require a new RI W-4 each year. A "
        + "current exempt flag withholds zero. Dating the year-end lapse is "
        + "certificate administration.",
    },
  ],
};

export const RI_REGION: PayrollRegionWithholding = {
  region: "RI",
  label: "Rhode Island income tax",
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "unknown",
  residentWithholdingImplemented: false,
  certificateKey: "us_ri_riw4",
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "Rhode Island Division of Taxation, 2026 Employer's Income Tax Withholding "
    + "Tables; Form RI W-4 (2026)",
};
