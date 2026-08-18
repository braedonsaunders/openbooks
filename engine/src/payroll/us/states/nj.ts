/**
 * New Jersey gross income tax withholding — the percentage method.
 *
 * Sources (fetched from nj.gov, not memory):
 *   NJ-WT, New Jersey Income Tax Withholding Instructions, September 2025 —
 *     the withholding allowance value table (p. 24), which rate table to use
 *     (p. 24), the supplemental-wage rule (p. 11), the residency rules (p. 8),
 *     the PA reciprocal agreement (p. 8), and the worked percentage-method
 *     examples (p. 25).
 *   TABLES FOR PERCENTAGE METHOD OF WITHHOLDING, "Applicable to Wages,
 *     Salaries, and Commissions Paid on and after October 1, 2020" — Rate
 *     Tables A–E, eight payroll periods each, transcribed in full below.
 *   Form NJ-W4 (1-21) — the certificate's own lines.
 *   Form NJ-165, Employee's Certificate of Nonresidence in New Jersey.
 *
 * ---------------------------------------------------------------------------
 * Why New Jersey is first in this wave
 * ---------------------------------------------------------------------------
 * It closes the pair Pennsylvania left half-built. PA/NJ is the one genuine
 * mutual reciprocal agreement in the north-east, and until New Jersey existed
 * as a computable region the resolver could only REFUSE the New Jersey half:
 * a NJ resident with a REV-419 on file was relieved of Pennsylvania tax and
 * nobody withheld New Jersey's.
 *
 * It is also the state that makes the difference between an AGREEMENT and a
 * CREDIT concrete, and getting that difference wrong is the single most common
 * error in this subject:
 *
 *   NJ ↔ PA   a reciprocal agreement, in both directions, on two forms — New
 *             Jersey takes Form NJ-165 from a Pennsylvania resident, and
 *             Pennsylvania takes Form REV-419 from a New Jersey resident.
 *   NJ ↔ NY   NOT an agreement. New York has none with anybody. A New Jersey
 *             resident who works in New York pays New York tax in full and New
 *             Jersey allows a CREDIT on the annual return. The employer's side
 *             of that is NJ-WT's own rule (p. 8), which this module declares as
 *             `required_net_of_credit` and does not compute — see
 *             engine/src/payroll/us/jurisdictions.ts.
 *
 * ---------------------------------------------------------------------------
 * The method
 * ---------------------------------------------------------------------------
 * NJ-WT p. 24, verbatim:
 *
 *   1. Multiply the proper withholding allowance (above table) by the number of
 *      exemptions claimed by the employee;
 *   2. Subtract this amount from the wages for the period to determine wages
 *      subject to withholding; and
 *   3. Refer to the New Jersey Withholding Rate Tables to determine the
 *      withholding amount.
 *
 * Five rate tables (A–E) × eight payroll periods, each a bracket schedule of
 * the form "over X but not over Y: $base plus R% of the excess over Z". The
 * employee picks the table on Form NJ-W4 — line 3 if they used the Wage Chart,
 * otherwise line 2's filing status decides it.
 *
 * BOUNDARIES ARE THE OTHER WAY ROUND FROM NEW YORK'S. New Jersey prints "Over"
 * and "But Not Over", so a line covers (X, Y] — exclusive at the bottom,
 * INCLUSIVE at the top. New York prints "At least" and "But less than", which
 * is [X, Y). Transcribing one with the other's comparison moves every employee
 * sitting exactly on a breakpoint into the wrong bracket.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
} from "../../certificates.ts";
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

const RATES_MODULE = "engine/src/payroll/us/states/nj.ts";

/** The five schedules Form NJ-W4 selects between. */
export type NjRateTable = "A" | "B" | "C" | "D" | "E";

/** Every payroll period New Jersey prints a table for — which is all of them. */
type NjPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const NJ_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

/**
 * One printed line: for taxable wages over `over` and not over `butNotOver`,
 * tax = `base` + `rate` × (wages − `ofExcessOver`).
 */
export interface NjRow {
  over: string;
  /** Null on the top line. INCLUSIVE — the column is "But Not Over". */
  butNotOver: string | null;
  base: string;
  /** As the publication prints it, for proof-reading against the PDF. */
  printedPercent: string;
  /** The decimal the engine multiplies by, derived from `printedPercent`. */
  rate: string;
  ofExcessOver: string;
}

export interface NjPeriodTable {
  /** NJ-WT p. 24 — the value of ONE withholding allowance for this period. */
  allowance: string;
  rows: readonly NjRow[];
}

function njRows(
  allowance: string,
  lines: readonly (readonly [string, string | null, string, string, string])[],
): NjPeriodTable {
  return {
    allowance,
    rows: lines.map(([over, butNotOver, base, printedPercent, ofExcessOver]) => ({
      over, butNotOver, base, printedPercent, rate: pctToRate(printedPercent), ofExcessOver,
    })),
  };
}

export interface NjYearRates {
  year: number;
  status: "published" | "draft";
  /** The date the rate tables themselves took effect, as printed on them. */
  tablesEffectiveFrom: string;
  tables: Readonly<Record<NjRateTable, Readonly<Record<NjPeriod, NjPeriodTable>>>>;
}

/**
 * 2026 — the rate tables in force are the ones headed "Applicable to Wages,
 * Salaries, and Commissions Paid on and after October 1, 2020", carried forward
 * unchanged, with NJ-WT (September 2025) as the current instructions.
 *
 * That is not a stale transcription: New Jersey has not revised the percentage
 * method tables since the 11.8% top bracket was added, and the September 2025
 * NJ-WT still directs employers to them. The effective date is recorded on the
 * edition so the fact is checkable rather than assumed.
 */
export const NJ_RATES_2026: NjYearRates = {
  year: 2026,
  status: "published",
  tablesEffectiveFrom: "2020-10-01",
  tables: {
  A: {
    weekly: njRows("19.20", [
      ["0", "385", "0", "1.5", "0"],
      ["385", "673", "5.77", "2.0", "385"],
      ["673", "769", "11.54", "3.9", "673"],
      ["769", "1442", "15.29", "6.1", "769"],
      ["1442", "9615", "56.35", "7.0", "1442"],
      ["9615", "19231", "628.46", "9.9", "9615"],
      ["19231", null, "1580.38", "11.8", "19231"],
    ]),
    biweekly: njRows("38.40", [
      ["0", "769", "0", "1.5", "0"],
      ["769", "1346", "12.00", "2.0", "769"],
      ["1346", "1538", "23.00", "3.9", "1346"],
      ["1538", "2885", "31.00", "6.1", "1538"],
      ["2885", "19231", "113.00", "7.0", "2885"],
      ["19231", "38462", "1257.00", "9.9", "19231"],
      ["38462", null, "3161.00", "11.8", "38462"],
    ]),
    semimonthly: njRows("41.60", [
      ["0", "833", "0", "1.5", "0"],
      ["833", "1458", "13.00", "2.0", "833"],
      ["1458", "1667", "25.00", "3.9", "1458"],
      ["1667", "3125", "33.00", "6.1", "1667"],
      ["3125", "20833", "122.00", "7.0", "3125"],
      ["20833", "41667", "1362.00", "9.9", "20833"],
      ["41667", null, "3424.00", "11.8", "41667"],
    ]),
    monthly: njRows("83.30", [
      ["0", "1667", "0", "1.5", "0"],
      ["1667", "2917", "25.00", "2.0", "1667"],
      ["2917", "3333", "50.00", "3.9", "2917"],
      ["3333", "6250", "66.00", "6.1", "3333"],
      ["6250", "41667", "244.00", "7.0", "6250"],
      ["41667", "83333", "2723.00", "9.9", "41667"],
      ["83333", null, "6848.00", "11.8", "83333"],
    ]),
    quarterly: njRows("250", [
      ["0", "5000", "0", "1.5", "0"],
      ["5000", "8750", "75.00", "2.0", "5000"],
      ["8750", "10000", "150.00", "3.9", "8750"],
      ["10000", "18750", "198.75", "6.1", "10000"],
      ["18750", "125000", "732.50", "7.0", "18750"],
      ["125000", "250000", "8170.00", "9.9", "125000"],
      ["250000", null, "20545.00", "11.8", "250000"],
    ]),
    semiannual: njRows("500", [
      ["0", "10000", "0", "1.5", "0"],
      ["10000", "17500", "150.00", "2.0", "10000"],
      ["17500", "20000", "300.00", "3.9", "17500"],
      ["20000", "37500", "397.50", "6.1", "20000"],
      ["37500", "250000", "1465.00", "7.0", "37500"],
      ["250000", "500000", "16340.00", "9.9", "250000"],
      ["500000", null, "41090.00", "11.8", "500000"],
    ]),
    annual: njRows("1000", [
      ["0", "20000", "0", "1.5", "0"],
      ["20000", "35000", "300.00", "2.0", "20000"],
      ["35000", "40000", "600.00", "3.9", "35000"],
      ["40000", "75000", "795.00", "6.1", "40000"],
      ["75000", "500000", "2930.00", "7.0", "75000"],
      ["500000", "1000000", "32680.00", "9.9", "500000"],
      ["1000000", null, "82180.00", "11.8", "1000000"],
    ]),
    daily: njRows("2.70", [
      ["0", "55", "0", "1.5", "0"],
      ["55", "96", "0.82", "2.0", "55"],
      ["96", "110", "1.64", "3.9", "96"],
      ["110", "205", "2.18", "6.1", "110"],
      ["205", "1370", "8.03", "7.0", "205"],
      ["1370", "2740", "89.53", "9.9", "1370"],
      ["2740", null, "225.15", "11.8", "2740"],
    ]),
  },
  B: {
    weekly: njRows("19.20", [
      ["0", "385", "0", "1.5", "0"],
      ["385", "962", "5.77", "2.0", "385"],
      ["962", "1346", "17.31", "2.7", "962"],
      ["1346", "1538", "27.69", "3.9", "1346"],
      ["1538", "2885", "35.19", "6.1", "1538"],
      ["2885", "9615", "117.31", "7.0", "2885"],
      ["9615", "19231", "588.46", "9.9", "9615"],
      ["19231", null, "1540.38", "11.8", "19231"],
    ]),
    biweekly: njRows("38.40", [
      ["0", "769", "0", "1.5", "0"],
      ["769", "1923", "12.00", "2.0", "769"],
      ["1923", "2692", "35.00", "2.7", "1923"],
      ["2692", "3077", "55.00", "3.9", "2692"],
      ["3077", "5769", "70.00", "6.1", "3077"],
      ["5769", "19231", "235.00", "7.0", "5769"],
      ["19231", "38462", "1177.00", "9.9", "19231"],
      ["38462", null, "3081.00", "11.8", "38462"],
    ]),
    semimonthly: njRows("41.60", [
      ["0", "833", "0", "1.5", "0"],
      ["833", "2083", "12.50", "2.0", "833"],
      ["2083", "2917", "37.50", "2.7", "2083"],
      ["2917", "3333", "59.99", "3.9", "2917"],
      ["3333", "6250", "76.25", "6.1", "3333"],
      ["6250", "20833", "254.19", "7.0", "6250"],
      ["20833", "41667", "1275.00", "9.9", "20833"],
      ["41667", null, "3338.00", "11.8", "41667"],
    ]),
    monthly: njRows("83.30", [
      ["0", "1667", "0", "1.5", "0"],
      ["1667", "4167", "25.00", "2.0", "1667"],
      ["4167", "5833", "75.00", "2.7", "4167"],
      ["5833", "6667", "120.00", "3.9", "5833"],
      ["6667", "12500", "153.00", "6.1", "6667"],
      ["12500", "41667", "508.00", "7.0", "12500"],
      ["41667", "83333", "2550.00", "9.9", "41667"],
      ["83333", null, "6675.00", "11.8", "83333"],
    ]),
    quarterly: njRows("250", [
      ["0", "5000", "0", "1.5", "0"],
      ["5000", "12500", "75.00", "2.0", "5000"],
      ["12500", "17500", "225.00", "2.7", "12500"],
      ["17500", "20000", "360.00", "3.9", "17500"],
      ["20000", "37500", "457.50", "6.1", "20000"],
      ["37500", "125000", "1525.00", "7.0", "37500"],
      ["125000", "250000", "7650.00", "9.9", "125000"],
      ["250000", null, "20025.00", "11.8", "250000"],
    ]),
    semiannual: njRows("500", [
      ["0", "10000", "0", "1.5", "0"],
      ["10000", "25000", "150.00", "2.0", "10000"],
      ["25000", "35000", "450.00", "2.7", "25000"],
      ["35000", "40000", "720.00", "3.9", "35000"],
      ["40000", "75000", "915.00", "6.1", "40000"],
      ["75000", "250000", "3050.00", "7.0", "75000"],
      ["250000", "500000", "15300.00", "9.9", "250000"],
      ["500000", null, "40050.00", "11.8", "500000"],
    ]),
    annual: njRows("1000", [
      ["0", "20000", "0", "1.5", "0"],
      ["20000", "50000", "300.00", "2.0", "20000"],
      ["50000", "70000", "900.00", "2.7", "50000"],
      ["70000", "80000", "1440.00", "3.9", "70000"],
      ["80000", "150000", "1830.00", "6.1", "80000"],
      ["150000", "500000", "6100.00", "7.0", "150000"],
      ["500000", "1000000", "30600.00", "9.9", "500000"],
      ["1000000", null, "80100.00", "11.8", "1000000"],
    ]),
    daily: njRows("2.70", [
      ["0", "55", "0", "1.5", "0"],
      ["55", "137", "0.82", "2.0", "55"],
      ["137", "192", "2.47", "2.7", "137"],
      ["192", "219", "3.95", "3.9", "192"],
      ["219", "411", "5.01", "6.1", "219"],
      ["411", "1370", "16.71", "7.0", "411"],
      ["1370", "2740", "83.84", "9.9", "1370"],
      ["2740", null, "219.45", "11.8", "2740"],
    ]),
  },
  C: {
    weekly: njRows("19.20", [
      ["0", "385", "0", "1.5", "0"],
      ["385", "769", "5.77", "2.3", "385"],
      ["769", "962", "14.62", "2.8", "769"],
      ["962", "1154", "20.00", "3.5", "962"],
      ["1154", "2885", "26.73", "5.6", "1154"],
      ["2885", "9615", "123.65", "6.6", "2885"],
      ["9615", "19231", "567.88", "9.9", "9615"],
      ["19231", null, "1519.81", "11.8", "19231"],
    ]),
    biweekly: njRows("38.40", [
      ["0", "769", "0", "1.5", "0"],
      ["769", "1538", "11.54", "2.3", "769"],
      ["1538", "1923", "29.23", "2.8", "1538"],
      ["1923", "2308", "40.00", "3.5", "1923"],
      ["2308", "5769", "53.46", "5.6", "2308"],
      ["5769", "19231", "247.31", "6.6", "5769"],
      ["19231", "38462", "1135.77", "9.9", "19231"],
      ["38462", null, "3039.62", "11.8", "38462"],
    ]),
    semimonthly: njRows("41.60", [
      ["0", "833", "0", "1.5", "0"],
      ["833", "1667", "12.50", "2.3", "833"],
      ["1667", "2083", "31.67", "2.8", "1667"],
      ["2083", "2500", "43.33", "3.5", "2083"],
      ["2500", "6250", "57.92", "5.6", "2500"],
      ["6250", "20833", "267.92", "6.6", "6250"],
      ["20833", "41667", "1230.42", "9.9", "20833"],
      ["41667", null, "3292.92", "11.8", "41667"],
    ]),
    monthly: njRows("83.30", [
      ["0", "1667", "0", "1.5", "0"],
      ["1667", "3333", "25.00", "2.3", "1667"],
      ["3333", "4167", "63.33", "2.8", "3333"],
      ["4167", "5000", "86.67", "3.5", "4167"],
      ["5000", "12500", "115.83", "5.6", "5000"],
      ["12500", "41667", "535.85", "6.6", "12500"],
      ["41667", "83333", "2460.83", "9.9", "41667"],
      ["83333", null, "6585.83", "11.8", "83333"],
    ]),
    quarterly: njRows("250", [
      ["0", "5000", "0", "1.5", "0"],
      ["5000", "10000", "75.00", "2.3", "5000"],
      ["10000", "12500", "190.00", "2.8", "10000"],
      ["12500", "15000", "260.00", "3.5", "12500"],
      ["15000", "37500", "347.50", "5.6", "15000"],
      ["37500", "125000", "1607.50", "6.6", "37500"],
      ["125000", "250000", "7382.50", "9.9", "125000"],
      ["250000", null, "19757.50", "11.8", "250000"],
    ]),
    semiannual: njRows("500", [
      ["0", "10000", "0", "1.5", "0"],
      ["10000", "20000", "150.00", "2.3", "10000"],
      ["20000", "25000", "380.00", "2.8", "20000"],
      ["25000", "30000", "520.00", "3.5", "25000"],
      ["30000", "75000", "695.00", "5.6", "30000"],
      ["75000", "250000", "3215.00", "6.6", "75000"],
      ["250000", "500000", "14765.00", "9.9", "250000"],
      ["500000", null, "39515.00", "11.8", "500000"],
    ]),
    annual: njRows("1000", [
      ["0", "20000", "0", "1.5", "0"],
      ["20000", "40000", "300.00", "2.3", "20000"],
      ["40000", "50000", "760.00", "2.8", "40000"],
      ["50000", "60000", "1040.00", "3.5", "50000"],
      ["60000", "150000", "1390.00", "5.6", "60000"],
      ["150000", "500000", "6430.00", "6.6", "150000"],
      ["500000", "1000000", "29530.00", "9.9", "500000"],
      ["1000000", null, "79030.00", "11.8", "1000000"],
    ]),
    daily: njRows("2.70", [
      ["0", "55", "0", "1.5", "0"],
      ["55", "110", "0.82", "2.3", "55"],
      ["110", "137", "2.08", "2.8", "110"],
      ["137", "164", "2.85", "3.5", "137"],
      ["164", "411", "3.81", "5.6", "164"],
      ["411", "1370", "17.62", "6.6", "411"],
      ["1370", "2740", "80.90", "9.9", "1370"],
      ["2740", null, "216.52", "11.8", "2740"],
    ]),
  },
  D: {
    weekly: njRows("19.20", [
      ["0", "385", "0", "1.5", "0"],
      ["385", "769", "5.77", "2.7", "385"],
      ["769", "962", "16.15", "3.4", "769"],
      ["962", "1154", "22.69", "4.3", "962"],
      ["1154", "2885", "30.96", "5.6", "1154"],
      ["2885", "9615", "127.88", "6.5", "2885"],
      ["9615", "19231", "565.38", "9.9", "9615"],
      ["19231", null, "1517.31", "11.8", "19231"],
    ]),
    biweekly: njRows("38.40", [
      ["0", "769", "0", "1.5", "0"],
      ["769", "1538", "11.54", "2.7", "769"],
      ["1538", "1923", "32.31", "3.4", "1538"],
      ["1923", "2308", "45.38", "4.3", "1923"],
      ["2308", "5769", "61.92", "5.6", "2308"],
      ["5769", "19231", "255.77", "6.5", "5769"],
      ["19231", "38462", "1130.77", "9.9", "19231"],
      ["38462", null, "3034.62", "11.8", "38462"],
    ]),
    semimonthly: njRows("41.60", [
      ["0", "833", "0", "1.5", "0"],
      ["833", "1667", "12.50", "2.7", "833"],
      ["1667", "2083", "35.00", "3.4", "1667"],
      ["2083", "2500", "49.17", "4.3", "2083"],
      ["2500", "6250", "67.08", "5.6", "2500"],
      ["6250", "20833", "277.08", "6.5", "6250"],
      ["20833", "41667", "1225.00", "9.9", "20833"],
      ["41667", null, "3287.50", "11.8", "41667"],
    ]),
    monthly: njRows("83.30", [
      ["0", "1667", "0", "1.5", "0"],
      ["1667", "3333", "25.00", "2.7", "1667"],
      ["3333", "4167", "70.00", "3.4", "3333"],
      ["4167", "5000", "98.33", "4.3", "4167"],
      ["5000", "12500", "134.17", "5.6", "5000"],
      ["12500", "41667", "554.17", "6.5", "12500"],
      ["41667", "83333", "2450.00", "9.9", "41667"],
      ["83333", null, "6575.00", "11.8", "83333"],
    ]),
    quarterly: njRows("250", [
      ["0", "5000", "0", "1.5", "0"],
      ["5000", "10000", "75.00", "2.7", "5000"],
      ["10000", "12500", "210.00", "3.4", "10000"],
      ["12500", "15000", "295.00", "4.3", "12500"],
      ["15.000", "37500", "402.50", "5.6", "15000"],
      ["37500", "125000", "1662.50", "6.5", "37500"],
      ["125000", "250000", "7350.00", "9.9", "125000"],
      ["250000", null, "19725.00", "11.8", "250000"],
    ]),
    semiannual: njRows("500", [
      ["0", "10000", "0", "1.5", "0"],
      ["10000", "20000", "150.00", "2.7", "10000"],
      ["20000", "25000", "420.00", "3.4", "20000"],
      ["25000", "30000", "590.00", "4.3", "25000"],
      ["30000", "75000", "805.00", "5.6", "30000"],
      ["75000", "250000", "3325.00", "6.5", "75000"],
      ["250000", "500000", "14700.00", "9.9", "250000"],
      ["500000", null, "39450.00", "11.8", "500000"],
    ]),
    annual: njRows("1000", [
      ["0", "20000", "0", "1.5", "0"],
      ["20000", "40000", "300.00", "2.7", "20000"],
      ["40000", "50000", "840.00", "3.4", "40000"],
      ["50000", "60000", "1180.00", "4.3", "50000"],
      ["60000", "150000", "1610.00", "5.6", "60000"],
      ["150000", "500000", "6650.00", "6.5", "150000"],
      ["500000", "1000000", "29400.00", "9.9", "500000"],
      ["1000000", null, "78900.00", "11.8", "1000000"],
    ]),
    daily: njRows("2.70", [
      ["0", "55", "0", "1.5", "0"],
      ["55", "110", "0.82", "2.7", "55"],
      ["110", "137", "2.30", "3.4", "110"],
      ["137", "164", "3.23", "4.3", "137"],
      ["164", "411", "4.41", "5.6", "164"],
      ["411", "1370", "18.22", "6.5", "411"],
      ["1370", "2740", "80.55", "9.9", "1370"],
      ["2740", null, "216.16", "11.8", "2740"],
    ]),
  },
  E: {
    weekly: njRows("19.20", [
      ["0", "385", "0", "1.5", "0"],
      ["385", "673", "5.77", "2.0", "385"],
      ["673", "1923", "11.54", "5.8", "673"],
      ["1923", "9615", "84.04", "6.5", "1923"],
      ["9615", "19231", "584.04", "9.9", "9615"],
      ["19231", null, "1535.96", "11.8", "19231"],
    ]),
    biweekly: njRows("38.40", [
      ["0", "769", "0", "1.5", "0"],
      ["769", "1346", "12.00", "2.0", "769"],
      ["1346", "3846", "23.00", "5.8", "1346"],
      ["3846", "19231", "168.00", "6.5", "3846"],
      ["19231", "38462", "1168.00", "9.9", "19231"],
      ["38462", null, "3072.00", "11.8", "38462"],
    ]),
    semimonthly: njRows("41.60", [
      ["0", "833", "0", "1.5", "0"],
      ["833", "1458", "13.00", "2.0", "833"],
      ["1458", "4167", "25.00", "5.8", "1458"],
      ["4167", "20833", "182.00", "6.5", "4167"],
      ["20833", "41667", "1265.00", "9.9", "20833"],
      ["41667", null, "3328.00", "11.8", "41667"],
    ]),
    monthly: njRows("83.30", [
      ["0", "1667", "0", "1.5", "0"],
      ["1667", "2916", "25.00", "2.0", "1667"],
      ["2917", "8333", "50.00", "5.8", "2917"],
      ["8333", "41667", "364.00", "6.5", "8333"],
      ["41667", "83333", "2531.00", "9.9", "41667"],
      ["83333", null, "6656.00", "11.8", "83333"],
    ]),
    quarterly: njRows("250", [
      ["0", "5000", "0", "1.5", "0"],
      ["5000", "8750", "75.00", "2.0", "5000"],
      ["8750", "25000", "150.00", "5.8", "8750"],
      ["25000", "125000", "1092.50", "6.5", "25000"],
      ["125000", "250000", "7592.50", "9.9", "125000"],
      ["250000", null, "19967.50", "11.8", "250000"],
    ]),
    semiannual: njRows("500", [
      ["0", "10000", "0", "1.5", "0"],
      ["10000", "17500", "150.00", "2.0", "10000"],
      ["17500", "50000", "300.00", "5.8", "17500"],
      ["50000", "250000", "2185.00", "6.5", "50000"],
      ["250000", "500000", "15185.00", "9.9", "250000"],
      ["500000", null, "39935.00", "11.8", "500000"],
    ]),
    annual: njRows("1000", [
      ["0", "20000", "0", "1.5", "0"],
      ["20000", "35000", "300.00", "2.0", "20000"],
      ["35000", "100000", "600.00", "5.8", "35000"],
      ["100000", "500000", "4370.00", "6.5", "100000"],
      ["500000", "1000000", "30370.00", "9.9", "500000"],
      ["1000000", null, "79870.00", "11.8", "1000000"],
    ]),
    daily: njRows("2.70", [
      ["0", "55", "0", "1.5", "0"],
      ["55", "96", "0.82", "2.0", "55"],
      ["96", "274", "1.64", "5.8", "96"],
      ["274", "1370", "11.97", "6.5", "274"],
      ["1370", "2740", "83.21", "9.9", "1370"],
      ["2740", null, "218.82", "11.8", "2740"],
    ]),
  },
  },
};

const NJ_EDITIONS_BY_YEAR: Record<number, NjYearRates> = {
  [NJ_RATES_2026.year]: NJ_RATES_2026,
};

export const NJ_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "NJ-WT (September 2025); percentage method tables effective 2020-10-01",
  effectiveFrom: "2026-01-01",
  citation:
    "New Jersey Division of Taxation, NJ-WT Income Tax Withholding Instructions (September 2025); "
    + "Tables for Percentage Method of Withholding, applicable to wages paid on and after "
    + "October 1, 2020; Form NJ-W4 (1-21)",
  status: "published",
  region: "NJ",
}];

export function njRatesForPayDate(payDate: string): NjYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = NJ_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(NJ_WITHHOLDING, year);
  }
  return rates;
}

function njPeriodFor(periodsPerYear: number): NjPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null) refuseUnprintedPeriod(NJ_WITHHOLDING, periodsPerYear);
  return period as NjPeriod;
}

/**
 * Which rate table applies, from Form NJ-W4.
 *
 * NJ-WT p. 24: "Withhold at Rate A if Box 1 or 3 on Line 2 (Filing Status) is
 * checked. Withhold at Rate B if Box 2, 4 or 5 is checked and Line 3 is blank.
 * Withhold at Rate Selected if employee completes Line 3."
 *
 * With NO certificate at all, NJ-WT states no rule — it says only that the
 * employer must give the employee an NJ-W4 and calculate from "the rate
 * selected by the employee on Form NJ-W4". The certificate's declared default
 * is therefore Single, which sends it to Rate A: of the two default paths that
 * is the one that withholds MORE at every wage, so an employee who has not
 * filed is over-withheld and refunded rather than under-withheld and billed.
 * Recorded as a choice, not a citation.
 */
export function njRateTableFor(input: {
  selectedTable: string | null;
  filingStatus: string | null;
}): NjRateTable {
  const selected = (input.selectedTable ?? "").trim().toUpperCase();
  if (selected === "A" || selected === "B" || selected === "C" || selected === "D"
    || selected === "E") {
    return selected;
  }
  switch (input.filingStatus) {
    case "married_joint":
    case "head_household":
    case "surviving_spouse":
      return "B";
    default:
      return "A";
  }
}

/** Find the printed line: over the first column, NOT over the second. */
function rowFor(table: NjPeriodTable, taxable: bigint): NjRow | null {
  for (const row of table.rows) {
    const over = U(row.over);
    // The first line is printed "$0 … $385", and a zero-wage payroll has to
    // land somewhere: treat the bottom of the schedule as inclusive of zero.
    const aboveFloor = over === 0n ? taxable >= 0n : taxable > over;
    if (!aboveFloor) continue;
    if (row.butNotOver == null || taxable <= U(row.butNotOver)) return row;
  }
  return null;
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = njRatesForPayDate(input.payDate);
  const period = njPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {};

  // NJ-W4 line 6: "You do not need to withhold if the employee writes EXEMPT on
  // line 6 of Form NJ-W4" (NJ-WT p. 11).
  if (certificateFlag(input.certificate, "exempt")) {
    factors.NJ_EXEMPT = "1";
    return { state: "NJ", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const table = njRateTableFor({
    selectedTable: certificateChoice(input.certificate, "rate_table"),
    filingStatus: certificateChoice(input.certificate, "filing_status"),
  });
  factors.NJ_RATE_TABLE = table;

  const schedule = rates.tables[table][period];
  const allowances = certificateCount(input.certificate, "allowances") ?? 0;

  // NJ-WT p. 11: supplemental wages paid at the same time as regular wages are
  // totalled with them and withheld "at the appropriate rate based on the
  // combined payment". Paid at a DIFFERENT time they are withheld without the
  // exemption allowances — a separate payment this engine is not told about, so
  // it is not silently assumed. `taxSupplemental` stays zero for that reason.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const exemption = U(schedule.allowance) * BigInt(allowances);
  factors.NJ_ALLOWANCE_VALUE = schedule.allowance;
  factors.NJ_EXEMPTION = D(exemption);

  const taxable = max0(wages - exemption);
  factors.NJ_TAXABLE = D(taxable);

  const row = rowFor(schedule, taxable);
  if (!row) {
    // Reachable ONLY through a defect in the state's own printed table — Rate E
    // monthly leaves a one-dollar hole between "$2,916" and "over $2,917". The
    // conformance test pins it. Refusing is the only defensible answer: the
    // rate for a wage the schedule does not cover is not something an engine
    // gets to invent, and withholding nothing would be a silent zero.
    throw new Error(
      `no New Jersey Rate Table "${table}" line covers taxable wages of ${D(taxable)} on a `
      + `${period} payroll. The state's printed table leaves a gap there; see ${RATES_MODULE} `
      + "and the conformance test, and confirm the bracket with the Division of Taxation before "
      + "paying this employee.",
    );
  }
  factors.NJ_BRACKET_RATE = row.printedPercent;
  const tax = U(row.base) + mulRateCents(taxable - U(row.ofExcessOver), row.rate);
  factors.NJ_TAX = D(tax);

  // NJ-W4 line 5 — a flat amount added AFTER the schedule, not taxed by it.
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  return {
    state: "NJ",
    year: rates.year,
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const NJ_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NJ",
  label: "New Jersey gross income tax",
  certificateKey: "us_nj_njw4",
  ratesModule: RATES_MODULE,
  editions: NJ_TAX_YEAR_EDITIONS,
  // New Jersey prints all eight — including quarterly, semiannual and annual,
  // which most states do not — so any standard frequency has a real table.
  printedPeriods: NJ_PERIODS,
  compute,
};
