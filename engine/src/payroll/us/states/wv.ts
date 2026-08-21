/**
 * West Virginia income-tax withholding — IT-100.2.A, the PERCENTAGE METHOD.
 *
 * Source (fetched from tax.wv.gov, not memory):
 *   Form WV IT-100.2A, Tables for Percentage Method of Withholding, March 2026,
 *     https://tax.wv.gov/Documents/Withholding/it100.2a.pdf
 *     — TWO EARNER/TWO OR MORE JOBS tables (pp. 1–2) and OPTIONAL ONE
 *       EARNER/ONE JOB tables (pp. 3–4); $2,000 per exemption (annual);
 *       six printed payroll periods.
 *   Withholding Help and General Information,
 *     https://tax.wv.gov/Business/Withholding/HelpAndGeneralInformation/Pages/WithholdingHelpAndGeneralInformation.aspx
 *     — Method II: "apply the appropriate rate, rounding the result to the
 *       nearest whole dollar." The wage-bracket tables (IT-100.2.B) "are
 *       based on two-earner/two-job income."
 *   Form WV IT-104 / IT-104NR, Rev. 03/2023,
 *     https://tax.wv.gov/Documents/Withholding/it104.pdf
 *     — line 4 exemptions (default zero if the form is not completed);
 *       line 5 one-earner checkbox (the optional lower schedule);
 *       line 6 additional withholding; the nonresidence / military-spouse
 *       exemption on IT-104NR.
 *
 * The percentage method is a printed per-period TABLE, not an annualized
 * formula. IT-100.2A prints weekly, biweekly, semimonthly, monthly, annual
 * and daily and nothing else. A quarterly payroll is refused rather than
 * scaled. The two-earner schedule is the default — it is the one the
 * wage-bracket tables are computed from, and IT-104 line 5 must be checked
 * to elect the optional one-earner schedule.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateCount, certificateFlag } from "../../certificates.ts";
import { roundDiv } from "../../../money.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/wv.ts";

type WvPeriod = "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual" | "daily";

const WV_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly", "annual", "daily",
];

export type WvSchedule = "two_earner" | "one_earner";

/** One printed percentage-method line. `upTo` is inclusive ("But Not Over"). */
export interface WvPercentageRow {
  upTo: string | null;
  over: string;
  base: string;
  /** Publication percent, already shifted by `pctToRate`. */
  rate: string;
}

export interface WvPeriodValues {
  /** "Gross Wage Minus $X for Each Exemption Claimed". */
  exemption: string;
  rows: readonly WvPercentageRow[];
}

export interface WvYearRates {
  year: number;
  status: "published" | "draft";
  /** Annual value of one IT-104 exemption — Table 5's own header. */
  exemptionPerYear: string;
  schedules: Readonly<Record<WvSchedule, Readonly<Record<WvPeriod, WvPeriodValues>>>>;
}

function row(
  over: string,
  upTo: string | null,
  base: string,
  printedPercent: string,
): WvPercentageRow {
  return { over, upTo, base, rate: pctToRate(printedPercent) };
}

export const WV_RATES_2026: WvYearRates = {
  year: 2026,
  status: "published",
  exemptionPerYear: "2000.00",
  schedules: {
    two_earner: {
      weekly: {
        exemption: "38.46",
        rows: [
          row("0", "144", "0", "2.11"),
          row("144", "361", "3.04", "2.81"),
          row("361", "577", "9.13", "3.16"),
          row("577", "866", "15.95", "4.22"),
          row("866", null, "28.14", "4.58"),
        ],
      },
      biweekly: {
        exemption: "76.92",
        rows: [
          row("0", "289", "0", "2.11"),
          row("289", "722", "6.09", "2.81"),
          row("722", "1154", "18.25", "3.16"),
          row("1154", "1731", "31.90", "4.22"),
          row("1731", null, "56.27", "4.58"),
        ],
      },
      semimonthly: {
        exemption: "83.33",
        rows: [
          row("0", "313", "0", "2.11"),
          row("313", "782", "6.60", "2.81"),
          row("782", "1250", "19.77", "3.16"),
          row("1250", "1875", "34.58", "4.22"),
          row("1875", null, "60.95", "4.58"),
        ],
      },
      monthly: {
        exemption: "166.67",
        rows: [
          row("0", "625", "0", "2.11"),
          row("625", "1562", "13.18", "2.81"),
          row("1562", "2500", "39.53", "3.16"),
          row("2500", "3750", "69.15", "4.22"),
          row("3750", null, "121.91", "4.58"),
        ],
      },
      annual: {
        exemption: "2000.00",
        rows: [
          row("0", "7500", "0", "2.11"),
          row("7500", "18750", "158.25", "2.81"),
          row("18750", "30000", "474.38", "3.16"),
          row("30000", "45000", "829.88", "4.22"),
          row("45000", null, "1462.88", "4.58"),
        ],
      },
      daily: {
        exemption: "7.66",
        rows: [
          row("0", "29", "0", "2.11"),
          row("29", "72", "0.60", "2.81"),
          row("72", "115", "1.82", "3.16"),
          row("115", "173", "3.17", "4.22"),
          row("173", null, "5.61", "4.58"),
        ],
      },
    },
    one_earner: {
      weekly: {
        exemption: "38.46",
        rows: [
          row("0", "192", "0", "2.11"),
          row("192", "481", "4.05", "2.81"),
          row("481", "769", "12.17", "3.16"),
          row("769", "1154", "21.27", "4.22"),
          row("1154", null, "37.52", "4.58"),
        ],
      },
      biweekly: {
        exemption: "76.92",
        rows: [
          row("0", "385", "0", "2.11"),
          row("385", "962", "8.12", "2.81"),
          row("962", "1538", "24.34", "3.16"),
          row("1538", "2308", "42.54", "4.22"),
          row("2308", null, "75.03", "4.58"),
        ],
      },
      semimonthly: {
        exemption: "83.33",
        rows: [
          row("0", "417", "0", "2.11"),
          row("417", "1042", "8.80", "2.81"),
          row("1042", "1667", "26.36", "3.16"),
          row("1667", "2500", "46.11", "4.22"),
          row("2500", null, "81.26", "4.58"),
        ],
      },
      monthly: {
        exemption: "166.67",
        rows: [
          row("0", "833", "0", "2.11"),
          row("833", "2083", "17.58", "2.81"),
          row("2083", "3333", "52.70", "3.16"),
          row("3333", "5000", "92.20", "4.22"),
          row("5000", null, "162.55", "4.58"),
        ],
      },
      annual: {
        exemption: "2000.00",
        rows: [
          row("0", "10000", "0", "2.11"),
          row("10000", "25000", "211.00", "2.81"),
          row("25000", "40000", "632.50", "3.16"),
          row("40000", "60000", "1106.50", "4.22"),
          row("60000", null, "1950.50", "4.58"),
        ],
      },
      daily: {
        exemption: "7.66",
        rows: [
          row("0", "38", "0", "2.11"),
          row("38", "96", "0.80", "2.81"),
          row("96", "153", "2.43", "3.16"),
          row("153", "230", "4.23", "4.22"),
          row("230", null, "7.48", "4.58"),
        ],
      },
    },
  },
};

const WV_EDITIONS_BY_YEAR: Record<number, WvYearRates> = {
  [WV_RATES_2026.year]: WV_RATES_2026,
};

export const WV_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "WV IT-100.2A (March 2026) Percentage Method",
  effectiveFrom: "2026-01-01",
  citation:
    "West Virginia Tax Division, Form WV IT-100.2A, Tables for Percentage Method of Withholding "
    + "(March 2026) — two-earner tables (pp. 1–2) and optional one-earner tables (pp. 3–4); "
    + "IT-104 Rev. 03/2023; Method II rounding to the nearest whole dollar",
  status: "published",
  region: "WV",
}];

export function wvRatesForPayDate(payDate: string): WvYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WV_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(WV_WITHHOLDING, year);
  }
  return rates;
}

function wvPeriodFor(periodsPerYear: number): WvPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null || !WV_PERIODS.includes(period)) {
    refuseUnprintedPeriod(WV_WITHHOLDING, periodsPerYear);
  }
  return period as WvPeriod;
}

const DOLLAR = 10_000n;

/** Method II: "rounding the result to the nearest whole dollar." */
export function wvRoundToDollar(units: bigint): bigint {
  return roundDiv(units, DOLLAR) * DOLLAR;
}

/**
 * IT-100.2A percentage method for one printed period and one schedule.
 *
 * Line by line: wages less (exemptions × the period's exemption value), look
 * up the printed band, apply base + rate × excess, round to the dollar.
 */
export function wvPercentageMethod(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  schedule: WvSchedule;
  exemptions: number;
}): { tax: bigint; factors: Record<string, string> } {
  const rates = wvRatesForPayDate(input.payDate);
  const period = wvPeriodFor(input.periodsPerYear);
  const values = rates.schedules[input.schedule][period];
  const factors: Record<string, string> = {
    WV_SCHEDULE: input.schedule,
    WV_PERIOD: period,
  };

  const exemption = U(values.exemption) * BigInt(Math.max(input.exemptions, 0));
  factors.WV_EXEMPTION = D(exemption);
  const taxable = max0(U(input.wages) - exemption);
  factors.WV_TAXABLE = D(taxable);

  // "Over $X But Not Over $Y": the first band includes zero; later bands are
  // exclusive of their `over`. A hole between printed lines is refused.
  const band = values.rows.find((candidate) => {
    const aboveFloor = candidate.over === "0" ? taxable >= 0n : taxable > U(candidate.over);
    const atOrUnderCeiling = candidate.upTo == null || taxable <= U(candidate.upTo);
    return aboveFloor && atOrUnderCeiling;
  });
  if (!band) {
    throw new Error(
      `no West Virginia ${input.schedule} ${period} line covers taxable wages of ${D(taxable)}`,
    );
  }
  factors.WV_BAND_OVER = band.over;
  const tax = wvRoundToDollar(U(band.base) + mulRateCents(max0(taxable - U(band.over)), band.rate));
  factors.WV_TAX = D(tax);
  return { tax, factors };
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = wvRatesForPayDate(input.payDate);

  if (
    certificateFlag(input.certificate, "exempt")
    || certificateFlag(input.certificate, "military_spouse_exempt")
  ) {
    return {
      state: "WV", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      factors: { WV_EXEMPT: "1" },
    };
  }

  // IT-104 line 5 must be checked to elect the optional one-earner schedule.
  // Unchecked — and no certificate on file — is the two-earner default the
  // wage-bracket tables themselves are computed from.
  const schedule: WvSchedule = certificateFlag(input.certificate, "one_earner")
    ? "one_earner"
    : "two_earner";
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  const { tax, factors } = wvPercentageMethod({
    payDate: input.payDate,
    periodsPerYear: input.periodsPerYear,
    wages: D(wages),
    schedule,
    exemptions,
  });

  // IT-104 line 6 — additional withholding, added AFTER the rounded tax.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "WV",
    year: rates.year,
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const WV_WITHHOLDING: UsStateWithholdingEngine = {
  state: "WV",
  label: "West Virginia income tax",
  certificateKey: "us_wv_it104",
  ratesModule: RATES_MODULE,
  editions: WV_TAX_YEAR_EDITIONS,
  printedPeriods: WV_PERIODS,
  compute,
};
