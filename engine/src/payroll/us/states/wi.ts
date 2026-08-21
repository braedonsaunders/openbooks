/**
 * Wisconsin income tax withholding — Publication W-166 ALTERNATE METHOD
 * (the computer formula).
 *
 * Source (fetched from revenue.wi.gov, not memory):
 *   Publication W-166, Withholding Tax Guide — January 2026
 *     (https://www.revenue.wi.gov/DOR%20Publications/pb166.pdf),
 *     Alternate Method of Withholding Wisconsin Income Tax pp. 25–26 and
 *     its three worked examples; reciprocity p. 8; Form WT-4 rules pp. 7–8.
 *     Laws interpreted as of January 15, 2026. The January 2026 edition
 *     reprints the formula that has been effective for withholding periods
 *     beginning on or after January 1, 2022 (Withholding Tax Update WTU-001,
 *     October 2025: no rate change planned).
 *   Form WT-4, Employee's Wisconsin Withholding Exemption Certificate
 *     (W-204, R. 8-23).
 *   Form W-220, Nonresident Employee's Withholding Reciprocity Declaration
 *     (R. 7-20).
 *
 * The formula annualizes, subtracts a phased-out standard deduction that
 * depends on Single vs Married and on the annual gross itself, subtracts
 * $400 per WT-4 exemption, applies the four-band rate schedule, and
 * de-annualizes. The three worked examples are the goldens.
 *
 * Supplemental wages paid with regular wages are aggregated (W-166 p. 25).
 * The optional flat-percentage table on the same page is an employer
 * election for separately paid supplementals and is not applied here.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/wi.ts";

export type WiSchedule = "single" | "married";

export interface WiDeduction {
  /** Full deduction when annual gross is below `phaseStart`. */
  full: string;
  /** Annual gross at which the phase-out begins (inclusive). */
  phaseStart: string;
  /** Annual gross at which the deduction is zero (inclusive). */
  phaseEnd: string;
  /** Printed percent of annual gross in excess of `phaseStart`. */
  phaseRate: string;
}

export interface WiBracket {
  /** Inclusive ceiling of this band; null is the open top. */
  notOver: string | null;
  /** Subtracted from annual net wage before the marginal rate. */
  ofExcessOver: string;
  rate: string;
  add: string;
}

export interface WiYearRates {
  year: number;
  status: "published" | "draft";
  exemption: string;
  deduction: Readonly<Record<WiSchedule, WiDeduction>>;
  brackets: readonly WiBracket[];
}

export const WI_RATES_2026: WiYearRates = {
  year: 2026,
  status: "published",
  exemption: "400",
  deduction: {
    single: {
      full: "6702",
      phaseStart: "17780",
      phaseEnd: "73630",
      phaseRate: pctToRate("12"),
    },
    married: {
      full: "9461",
      phaseStart: "25727",
      phaseEnd: "73032",
      phaseRate: pctToRate("20"),
    },
  },
  brackets: [
    { notOver: "12760", ofExcessOver: "0", rate: pctToRate("3.54"), add: "0" },
    { notOver: "25520", ofExcessOver: "12760", rate: pctToRate("4.65"), add: "451.70" },
    { notOver: "280950", ofExcessOver: "25520", rate: pctToRate("5.30"), add: "1045.04" },
    { notOver: null, ofExcessOver: "280950", rate: pctToRate("7.65"), add: "14582.83" },
  ],
};

const WI_EDITIONS_BY_YEAR: Record<number, WiYearRates> = {
  [WI_RATES_2026.year]: WI_RATES_2026,
};

export const WI_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "Publication W-166 (January 2026), Alternate Method",
  effectiveFrom: "2026-01-01",
  citation:
    "Wisconsin Department of Revenue, Publication W-166, Withholding Tax Guide (January 2026), "
    + "Alternate Method of Withholding Wisconsin Income Tax (pp. 25–26); Form WT-4 (W-204 R. 8-23)",
  status: "published",
  region: "WI",
}];

export function wiRatesForPayDate(payDate: string): WiYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = WI_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(WI_WITHHOLDING, year);
  }
  return rates;
}

/**
 * WT-4 marital-status boxes onto the two deduction formulas.
 *
 * "Married, but withhold at higher Single rate" uses the Single deduction —
 * the box's own words. W-166 p. 8: if the employee fails to furnish a WT-4
 * (including after an expired complete-exemption claim), "the employee shall
 * be considered as claiming zero withholding exemptions." Marital status is
 * not named in that sentence; Single is the certificate's declared default
 * and the higher-tax box.
 */
export function wiScheduleFor(maritalStatus: string | null): WiSchedule {
  return maritalStatus === "married" ? "married" : "single";
}

/**
 * W-166 p. 25 step (b) — the phased-out standard deduction.
 *
 * Single: $6,702 below $17,780; $0 at $73,630 or more; otherwise
 *   $6,702 − 12% of (annual gross − $17,780).
 * Married: $9,461 below $25,727; $0 at $73,032 or more; otherwise
 *   $9,461 − 20% of (annual gross − $25,727).
 */
export function wiDeduction(annualGross: bigint, schedule: WiSchedule, rates: WiYearRates): bigint {
  const row = rates.deduction[schedule];
  if (annualGross < U(row.phaseStart)) return U(row.full);
  if (annualGross >= U(row.phaseEnd)) return 0n;
  return max0(U(row.full) - mulRateCents(annualGross - U(row.phaseStart), row.phaseRate));
}

/** W-166 p. 26 schedule of tax rates. */
export function wiAnnualTax(net: bigint, rates: WiYearRates): bigint {
  if (net <= 0n) return 0n;
  for (const band of rates.brackets) {
    if (band.notOver === null || net <= U(band.notOver)) {
      return U(band.add) + mulRateCents(net - U(band.ofExcessOver), band.rate);
    }
  }
  return 0n;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = wiRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Wisconsin withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  if (certificateFlag(input.certificate, "exempt")) {
    return {
      state: "WI", year: rates.year, tax: D(0n), taxSupplemental: D(0n),
      factors: { WI_EXEMPT: "1" },
    };
  }

  const schedule = wiScheduleFor(certificateChoice(input.certificate, "marital_status"));
  factors.WI_SCHEDULE = schedule;
  const exemptions = certificateCount(input.certificate, "exemptions") ?? 0;

  // W-166 p. 25: paid with regular wages, treat as one payment.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const annualGross = wages * BigInt(P);
  trace("WI_ANNUAL_GROSS", annualGross);

  const deduction = wiDeduction(annualGross, schedule, rates);
  trace("WI_DEDUCTION", deduction);

  const exemption = U(rates.exemption) * BigInt(Math.max(exemptions, 0));
  trace("WI_EXEMPTION", exemption);

  const net = max0(annualGross - deduction - exemption);
  trace("WI_ANNUAL_NET", net);

  const annualTax = wiAnnualTax(net, rates);
  trace("WI_ANNUAL_TAX", annualTax);

  const periodTax = divIntCents(annualTax, P);
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = periodTax + extra;
  trace("WI_WITHHELD", total);

  return {
    state: "WI",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const WI_WITHHOLDING: UsStateWithholdingEngine = {
  state: "WI",
  label: "Wisconsin income tax",
  certificateKey: "us_wi_wt4",
  ratesModule: RATES_MODULE,
  editions: WI_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};
