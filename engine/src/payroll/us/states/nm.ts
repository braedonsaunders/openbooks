/**
 * New Mexico wage withholding tax — the percentage method.
 *
 * Source (fetched from tax.newmexico.gov, not memory):
 *   FYI-104, New Mexico Withholding Tax, REV. 11/2025, "Effective
 *     January 1, 2026",
 *     https://realfile.tax.newmexico.gov/FYI-104.pdf
 *     — "How to use the Withholding Tax Tables" with the official worked
 *       example (married, $1,000.00 weekly + $20.00 additional = $41.80);
 *       Tables 1–8 for the percentage method of withholding ("For wages
 *       paid on or after January 1, 2026"), each in three columns
 *       (a) SINGLE / (b) MARRIED / (c) HEAD of HOUSEHOLD; the 5.9% flat
 *       rule for separately-paid supplemental wages and fringe benefits;
 *       the higher-single-rate rule; the $1-a-month rule; the no-state-W-4
 *       rule; the 15-day nonresident exception; the other-state credit.
 *
 * ---------------------------------------------------------------------------
 * The method (FYI-104 pp. 2–4)
 * ---------------------------------------------------------------------------
 * There is no annualization and no allowance subtraction: the tables were
 * "updated to reflect the standard deduction for the year and the change to
 * the federal W-4 by removing withholding allowance deduction amounts from
 * wages." The employer finds the table for the payroll period, the column
 * for the filing status, and the line for the wages — "Over X but not over
 * Y: $base plus R% of the excess over Z" — and adds any additional amount
 * the employee requested on the W-4 held for New Mexico purposes.
 *
 * BOUNDARIES READ THE NEW JERSEY WAY. New Mexico prints "Over" and "But Not
 * Over", so a line covers (X, Y] — exclusive at the bottom, INCLUSIVE at
 * the top — exactly like the NJ rate tables and the opposite way round from
 * New York's "At least / But less than". The "Not Over $N → $0.00" head line
 * is the bottom row: wages in [0, N] owe nothing.
 *
 * ---------------------------------------------------------------------------
 * Table 3 carries a misprint, and this module follows the schedule, not it
 * ---------------------------------------------------------------------------
 * Table 3 (semimonthly) heads its three columns "Not Over $304 / $608 /
 * $456 → $0.00", but every first schedule line reads "Over $335 / $671 /
 * $503". The schedule is right and the head line is stale, three ways:
 * the nine schedule rows are the annual table divided by 24 and rounded to
 * the cent in every column (e.g. single $8,050 ÷ 24 = $335.42 → $335;
 * $82.50 ÷ 24 = $3.4375 → $3.44; married $16,100 ÷ 24 = $670.83 → $671),
 * the head-line figures match NOTHING (no table, no divisor, no prior
 * column), and all seven other tables chain their head line into their
 * first "Over" without a gap. The zero rows below therefore run to the
 * schedule's first "Over" ($335 / $671 / $503), and the conformance test
 * pins both the misprint and the reading so the choice is on the record
 * rather than invisible. The New Jersey engine documents the same class of
 * decision the same way (its "$15.000" line).
 *
 * ---------------------------------------------------------------------------
 * What this engine does NOT do
 * ---------------------------------------------------------------------------
 * - Separately-paid supplemental wages, overtime and bonuses: FYI-104
 *   "recommends using Table 8" for them, and where the federal calculation
 *   uses a flat percent, "a flat 5.9% of the supplemental wage or fringe
 *   benefit amount should be withheld for state tax purposes." Whether a
 *   payment WAS separate is a payroll fact this engine is not told, so
 *   wages handed in together are tabled together (the federal combined
 *   method FYI-104 points at), `taxSupplemental` stays zero, and the 5.9%
 *   rule is exported as `nmSupplementalFlat` for the caller that knows the
 *   payment stood alone. Same shape as the New Jersey engine's comment.
 * - The cumulative method: permitted ("you may use this same method for
 *   your state withholding") but it needs year-to-date history the input
 *   does not carry. Not assumed.
 * - Gambling winnings (6%, on the non-wage return TRD-41409) and pension /
 *   annuity withholding (on request, same return): non-wage levies outside
 *   the wage engine, noted here rather than invented.
 * - The 15-or-fewer-days nonresident exception: needs a day count the
 *   engine is not given, like Pennsylvania's working-day allocation. The
 *   region declares the general rule (nonresident NM-source wages ARE
 *   taxed) and the exception lives in the comment, not in a guessed
 *   day-count field.
 * - The other-state credit for residents taxed elsewhere: declared on the
 *   region as `required_net_of_credit` and refused (not computed), the
 *   New Jersey shape.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { PayrollError } from "../../error.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateFlag,
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

const RATES_MODULE = "engine/src/payroll/us/states/nm.ts";

/** FYI-104's three columns: (a) SINGLE, (b) MARRIED, (c) HEAD of HOUSEHOLD. */
export type NmFilingStatus = "single" | "married" | "head_household";

/** Every payroll period FYI-104 Tables 1–8 print — which is all of them. */
type NmPeriod =
  | "weekly" | "biweekly" | "semimonthly" | "monthly"
  | "quarterly" | "semiannual" | "annual" | "daily";

const NM_PERIODS: readonly UsStatePayPeriod[] = [
  "weekly", "biweekly", "semimonthly", "monthly",
  "quarterly", "semiannual", "annual", "daily",
];

/**
 * One printed line: for wages over `over` and not over `butNotOver`,
 * tax = `base` + `rate` × (wages − `ofExcessOver`).
 *
 * The "Not Over $N → $0.00" head line is encoded as the bottom row with a
 * zero base and a zero rate: the publication prints an AMOUNT ($0.00), not
 * a percent, and a zero-rate row says exactly that.
 */
export interface NmRow {
  over: string;
  /** Null on the top line. INCLUSIVE — the column is "But Not Over". */
  butNotOver: string | null;
  base: string;
  /** As the publication prints it ("1.5"), for proof-reading against the PDF. */
  printedPercent: string;
  /** The decimal the engine multiplies by, derived from `printedPercent`. */
  rate: string;
  ofExcessOver: string;
}

export interface NmPeriodTable {
  rows: readonly NmRow[];
}

function nmRows(
  lines: readonly (readonly [string, string | null, string, string, string])[],
): NmPeriodTable {
  return {
    rows: lines.map(([over, butNotOver, base, printedPercent, ofExcessOver]) => ({
      over, butNotOver, base, printedPercent, rate: pctToRate(printedPercent), ofExcessOver,
    })),
  };
}

export interface NmYearRates {
  year: number;
  status: "published" | "draft";
  tables: Readonly<Record<NmFilingStatus, Readonly<Record<NmPeriod, NmPeriodTable>>>>;
  /** Flat rate for separately-paid supplemental wages (FYI-104 p. 4). */
  supplementalRate: string;
}

/**
 * 2026 — FYI-104 REV. 11/2025, "For wages paid on or after January 1, 2026".
 * Every figure below is the publication's own digits: bracket tops, base
 * amounts and printed percents are transcribed, never scaled from the
 * annual table even where the publication plainly scaled them itself.
 */
export const NM_RATES_2026: NmYearRates = {
  year: 2026,
  status: "published",
  supplementalRate: pctToRate("5.9"),
  tables: {
  single: {
    weekly: nmRows([
      ["0", "155", "0.00", "0", "0"],
      ["155", "261", "0.00", "1.5", "155"],
      ["261", "395", "1.59", "3.2", "261"],
      ["395", "472", "5.89", "3.2", "395"],
      ["472", "645", "8.36", "4.3", "472"],
      ["645", "799", "15.80", "4.3", "645"],
      ["799", "1126", "22.41", "4.7", "799"],
      ["1126", "1434", "37.78", "4.7", "1126"],
      ["1434", "4193", "52.24", "4.9", "1434"],
      ["4193", null, "187.46", "5.9", "4193"],
    ]),
    biweekly: nmRows([
      ["0", "310", "0.00", "0", "0"],
      ["310", "521", "0.00", "1.5", "310"],
      ["521", "790", "3.17", "3.2", "521"],
      ["790", "944", "11.79", "3.2", "790"],
      ["944", "1290", "16.71", "4.3", "944"],
      ["1290", "1598", "31.60", "4.3", "1290"],
      ["1598", "2252", "44.83", "4.7", "1598"],
      ["2252", "2867", "75.56", "4.7", "2252"],
      ["2867", "8387", "104.48", "4.9", "2867"],
      ["8387", null, "374.92", "5.9", "8387"],
    ]),
    // Zero row runs to $335, the schedule's first "Over" — the head line's
    // $304 matches nothing and is documented above, not transcribed.
    semimonthly: nmRows([
      ["0", "335", "0.00", "0", "0"],
      ["335", "565", "0.00", "1.5", "335"],
      ["565", "856", "3.44", "3.2", "565"],
      ["856", "1023", "12.77", "3.2", "856"],
      ["1023", "1398", "18.10", "4.3", "1023"],
      ["1398", "1731", "34.23", "4.3", "1398"],
      ["1731", "2440", "48.56", "4.7", "1731"],
      ["2440", "3106", "81.85", "4.7", "2440"],
      ["3106", "9085", "113.19", "4.9", "3106"],
      ["9085", null, "406.17", "5.9", "9085"],
    ]),
    monthly: nmRows([
      ["0", "671", "0.00", "0", "0"],
      ["671", "1129", "0.00", "1.5", "671"],
      ["1129", "1713", "6.88", "3.2", "1129"],
      ["1713", "2046", "25.54", "3.2", "1713"],
      ["2046", "2796", "36.21", "4.3", "2046"],
      ["2796", "3463", "68.46", "4.3", "2796"],
      ["3463", "4879", "97.13", "4.7", "3463"],
      ["4879", "6213", "163.71", "4.7", "4879"],
      ["6213", "18171", "226.38", "4.9", "6213"],
      ["18171", null, "812.33", "5.9", "18171"],
    ]),
    quarterly: nmRows([
      ["0", "2013", "0.00", "0", "0"],
      ["2013", "3388", "0.00", "1.5", "2013"],
      ["3388", "5138", "20.63", "3.2", "3388"],
      ["5138", "6138", "76.63", "3.2", "5138"],
      ["6138", "8388", "108.63", "4.3", "6138"],
      ["8388", "10388", "205.38", "4.3", "8388"],
      ["10388", "14638", "291.38", "4.7", "10388"],
      ["14638", "18638", "491.13", "4.7", "14638"],
      ["18638", "54513", "679.13", "4.9", "18638"],
      ["54513", null, "2437.00", "5.9", "54513"],
    ]),
    semiannual: nmRows([
      ["0", "4025", "0.00", "0", "0"],
      ["4025", "6775", "0.00", "1.5", "4025"],
      ["6775", "10275", "41.25", "3.2", "6775"],
      ["10275", "12275", "153.25", "3.2", "10275"],
      ["12275", "16775", "217.25", "4.3", "12275"],
      ["16775", "20775", "410.75", "4.3", "16775"],
      ["20775", "29275", "582.75", "4.7", "20775"],
      ["29275", "37275", "982.25", "4.7", "29275"],
      ["37275", "109025", "1358.25", "4.9", "37275"],
      ["109025", null, "4874.00", "5.9", "109025"],
    ]),
    annual: nmRows([
      ["0", "8050", "0.00", "0", "0"],
      ["8050", "13550", "0.00", "1.5", "8050"],
      ["13550", "20550", "82.50", "3.2", "13550"],
      ["20550", "24550", "306.50", "3.2", "20550"],
      ["24550", "33550", "434.50", "4.3", "24550"],
      ["33550", "41550", "821.50", "4.3", "33550"],
      ["41550", "58550", "1165.50", "4.7", "41550"],
      ["58550", "74550", "1964.50", "4.7", "58550"],
      ["74550", "218050", "2716.50", "4.9", "74550"],
      ["218050", null, "9748.00", "5.9", "218050"],
    ]),
    daily: nmRows([
      ["0", "31.00", "0.00", "0", "0"],
      ["31.00", "52.10", "0.00", "1.5", "31.00"],
      ["52.10", "79.00", "0.32", "3.2", "52.10"],
      ["79.00", "94.40", "1.18", "3.2", "79.00"],
      ["94.40", "129.00", "1.67", "4.3", "94.40"],
      ["129.00", "159.80", "3.16", "4.3", "129.00"],
      ["159.80", "225.20", "4.48", "4.7", "159.80"],
      ["225.20", "286.70", "7.56", "4.7", "225.20"],
      ["286.70", "838.70", "10.45", "4.9", "286.70"],
      ["838.70", null, "37.49", "5.9", "838.70"],
    ]),
  },
  married: {
    weekly: nmRows([
      ["0", "310", "0.00", "0", "0"],
      ["310", "463", "0.00", "1.5", "310"],
      ["463", "617", "2.31", "3.2", "463"],
      ["617", "790", "7.23", "3.2", "617"],
      ["790", "1098", "12.77", "4.3", "790"],
      ["1098", "1271", "26.00", "4.3", "1098"],
      ["1271", "1963", "33.44", "4.7", "1271"],
      ["1963", "2233", "65.98", "4.7", "1963"],
      ["2233", "6367", "78.63", "4.9", "2233"],
      ["6367", null, "281.23", "5.9", "6367"],
    ]),
    biweekly: nmRows([
      ["0", "619", "0.00", "0", "0"],
      ["619", "927", "0.00", "1.5", "619"],
      ["927", "1235", "4.62", "3.2", "927"],
      ["1235", "1581", "14.46", "3.2", "1235"],
      ["1581", "2196", "25.54", "4.3", "1581"],
      ["2196", "2542", "52.00", "4.3", "2196"],
      ["2542", "3927", "66.88", "4.7", "2542"],
      ["3927", "4465", "131.96", "4.7", "3927"],
      ["4465", "12735", "157.27", "4.9", "4465"],
      ["12735", null, "562.46", "5.9", "12735"],
    ]),
    // Head line prints $608; the schedule's first "Over" is $671 (see above).
    semimonthly: nmRows([
      ["0", "671", "0.00", "0", "0"],
      ["671", "1004", "0.00", "1.5", "671"],
      ["1004", "1338", "5.00", "3.2", "1004"],
      ["1338", "1713", "15.67", "3.2", "1338"],
      ["1713", "2379", "27.67", "4.3", "1713"],
      ["2379", "2754", "56.33", "4.3", "2379"],
      ["2754", "4254", "72.46", "4.7", "2754"],
      ["4254", "4838", "142.96", "4.7", "4254"],
      ["4838", "13796", "170.38", "4.9", "4838"],
      ["13796", null, "609.33", "5.9", "13796"],
    ]),
    monthly: nmRows([
      ["0", "1342", "0.00", "0", "0"],
      ["1342", "2008", "0.00", "1.5", "1342"],
      ["2008", "2675", "10.00", "3.2", "2008"],
      ["2675", "3425", "31.33", "3.2", "2675"],
      ["3425", "4758", "55.33", "4.3", "3425"],
      ["4758", "5508", "112.67", "4.3", "4758"],
      ["5508", "8508", "144.92", "4.7", "5508"],
      ["8508", "9675", "285.92", "4.7", "8508"],
      ["9675", "27592", "340.75", "4.9", "9675"],
      ["27592", null, "1218.67", "5.9", "27592"],
    ]),
    quarterly: nmRows([
      ["0", "4025", "0.00", "0", "0"],
      ["4025", "6025", "0.00", "1.5", "4025"],
      ["6025", "8025", "30.00", "3.2", "6025"],
      ["8025", "10275", "94.00", "3.2", "8025"],
      ["10275", "14275", "166.00", "4.3", "10275"],
      ["14275", "16525", "338.00", "4.3", "14275"],
      ["16525", "25525", "434.75", "4.7", "16525"],
      ["25525", "29025", "857.75", "4.7", "25525"],
      ["29025", "82775", "1022.25", "4.9", "29025"],
      ["82775", null, "3656.00", "5.9", "82775"],
    ]),
    semiannual: nmRows([
      ["0", "8050", "0.00", "0", "0"],
      ["8050", "12050", "0.00", "1.5", "8050"],
      ["12050", "16050", "60.00", "3.2", "12050"],
      ["16050", "20550", "188.00", "3.2", "16050"],
      ["20550", "28550", "332.00", "4.3", "20550"],
      ["28550", "33050", "676.00", "4.3", "28550"],
      ["33050", "51050", "869.50", "4.7", "33050"],
      ["51050", "58050", "1715.50", "4.7", "51050"],
      ["58050", "165550", "2044.50", "4.9", "58050"],
      ["165550", null, "7312.00", "5.9", "165550"],
    ]),
    annual: nmRows([
      ["0", "16100", "0.00", "0", "0"],
      ["16100", "24100", "0.00", "1.5", "16100"],
      ["24100", "32100", "120.00", "3.2", "24100"],
      ["32100", "41100", "376.00", "3.2", "32100"],
      ["41100", "57100", "664.00", "4.3", "41100"],
      ["57100", "66100", "1352.00", "4.3", "57100"],
      ["66100", "102100", "1739.00", "4.7", "66100"],
      ["102100", "116100", "3431.00", "4.7", "102100"],
      ["116100", "331100", "4089.00", "4.9", "116100"],
      ["331100", null, "14624.00", "5.9", "331100"],
    ]),
    daily: nmRows([
      ["0", "61.90", "0.00", "0", "0"],
      ["61.90", "92.70", "0.00", "1.5", "61.90"],
      ["92.70", "123.50", "0.46", "3.2", "92.70"],
      ["123.50", "158.10", "1.45", "3.2", "123.50"],
      ["158.10", "219.60", "2.55", "4.3", "158.10"],
      ["219.60", "254.20", "5.20", "4.3", "219.60"],
      ["254.20", "392.70", "6.69", "4.7", "254.20"],
      ["392.70", "446.50", "13.20", "4.7", "392.70"],
      ["446.50", "1273.50", "15.73", "4.9", "446.50"],
      ["1273.50", null, "56.25", "5.9", "1273.50"],
    ]),
  },
  head_household: {
    weekly: nmRows([
      ["0", "232", "0.00", "0", "0"],
      ["232", "386", "0.00", "1.5", "232"],
      ["386", "540", "2.31", "3.2", "386"],
      ["540", "713", "7.23", "3.2", "540"],
      ["713", "1021", "12.77", "4.3", "713"],
      ["1021", "1194", "26.00", "4.3", "1021"],
      ["1194", "1886", "33.44", "4.7", "1194"],
      ["1886", "2155", "65.98", "4.7", "1886"],
      ["2155", "6290", "78.63", "4.9", "2155"],
      ["6290", null, "281.23", "5.9", "6290"],
    ]),
    biweekly: nmRows([
      ["0", "464", "0.00", "0", "0"],
      ["464", "772", "0.00", "1.5", "464"],
      ["772", "1080", "4.62", "3.2", "772"],
      ["1080", "1426", "14.46", "3.2", "1080"],
      ["1426", "2041", "25.54", "4.3", "1426"],
      ["2041", "2388", "52.00", "4.3", "2041"],
      ["2388", "3772", "66.88", "4.7", "2388"],
      ["3772", "4311", "131.96", "4.7", "3772"],
      ["4311", "12580", "157.27", "4.9", "4311"],
      ["12580", null, "562.46", "5.9", "12580"],
    ]),
    // Head line prints $456; the schedule's first "Over" is $503 (see above).
    semimonthly: nmRows([
      ["0", "503", "0.00", "0", "0"],
      ["503", "836", "0.00", "1.5", "503"],
      ["836", "1170", "5.00", "3.2", "836"],
      ["1170", "1545", "15.67", "3.2", "1170"],
      ["1545", "2211", "27.67", "4.3", "1545"],
      ["2211", "2586", "56.33", "4.3", "2211"],
      ["2586", "4086", "72.46", "4.7", "2586"],
      ["4086", "4670", "142.96", "4.7", "4086"],
      ["4670", "13628", "170.38", "4.9", "4670"],
      ["13628", null, "609.33", "5.9", "13628"],
    ]),
    monthly: nmRows([
      ["0", "1006", "0.00", "0", "0"],
      ["1006", "1673", "0.00", "1.5", "1006"],
      ["1673", "2340", "10.00", "3.2", "1673"],
      ["2340", "3090", "31.33", "3.2", "2340"],
      ["3090", "4423", "55.33", "4.3", "3090"],
      ["4423", "5173", "112.67", "4.3", "4423"],
      ["5173", "8173", "144.92", "4.7", "5173"],
      ["8173", "9340", "285.92", "4.7", "8173"],
      ["9340", "27256", "340.75", "4.9", "9340"],
      ["27256", null, "1218.67", "5.9", "27256"],
    ]),
    quarterly: nmRows([
      ["0", "3019", "0.00", "0", "0"],
      ["3019", "5019", "0.00", "1.5", "3019"],
      ["5019", "7019", "30.00", "3.2", "5019"],
      ["7019", "9269", "94.00", "3.2", "7019"],
      ["9269", "13269", "166.00", "4.3", "9269"],
      ["13269", "15519", "338.00", "4.3", "13269"],
      ["15519", "24519", "434.75", "4.7", "15519"],
      ["24519", "28019", "857.75", "4.7", "24519"],
      ["28019", "81769", "1022.25", "4.9", "28019"],
      ["81769", null, "3656.00", "5.9", "81769"],
    ]),
    semiannual: nmRows([
      ["0", "6038", "0.00", "0", "0"],
      ["6038", "10038", "0.00", "1.5", "6038"],
      ["10038", "14038", "60.00", "3.2", "10038"],
      ["14038", "18538", "188.00", "3.2", "14038"],
      ["18538", "26538", "332.00", "4.3", "18538"],
      ["26538", "31038", "676.00", "4.3", "26538"],
      ["31038", "49038", "869.50", "4.7", "31038"],
      ["49038", "56038", "1715.50", "4.7", "49038"],
      ["56038", "163538", "2044.50", "4.9", "56038"],
      ["163538", null, "7312.00", "5.9", "163538"],
    ]),
    annual: nmRows([
      ["0", "12075", "0.00", "0", "0"],
      ["12075", "20075", "0.00", "1.5", "12075"],
      ["20075", "28075", "120.00", "3.2", "20075"],
      ["28075", "37075", "376.00", "3.2", "28075"],
      ["37075", "53075", "664.00", "4.3", "37075"],
      ["53075", "62075", "1352.00", "4.3", "53075"],
      ["62075", "98075", "1739.00", "4.7", "62075"],
      ["98075", "112075", "3431.00", "4.7", "98075"],
      ["112075", "327075", "4089.00", "4.9", "112075"],
      ["327075", null, "14624.00", "5.9", "327075"],
    ]),
    daily: nmRows([
      ["0", "46.40", "0.00", "0", "0"],
      ["46.40", "77.20", "0.00", "1.5", "46.40"],
      ["77.20", "108.00", "0.46", "3.2", "77.20"],
      ["108.00", "142.60", "1.45", "3.2", "108.00"],
      ["142.60", "204.10", "2.55", "4.3", "142.60"],
      ["204.10", "238.80", "5.20", "4.3", "204.10"],
      ["238.80", "377.20", "6.69", "4.7", "238.80"],
      ["377.20", "431.10", "13.20", "4.7", "377.20"],
      ["431.10", "1258.00", "15.73", "4.9", "431.10"],
      ["1258.00", null, "56.25", "5.9", "1258.00"],
    ]),
  },
  },
};

const NM_EDITIONS_BY_YEAR: Record<number, NmYearRates> = {
  [NM_RATES_2026.year]: NM_RATES_2026,
};

export const NM_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "FYI-104 percentage-method tables (REV. 11/2025, for wages paid on or after 2026-01-01)",
  effectiveFrom: "2026-01-01",
  citation:
    "New Mexico Taxation and Revenue Department, FYI-104 New Mexico Withholding Tax, "
    + "REV. 11/2025 — Tables 1–8 for the percentage method of withholding; $1,000 "
    + "married-weekly worked example ($21.80 + $20.00 additional = $41.80)",
  status: "published",
  region: "NM",
}];

export function nmRatesForPayDate(payDate: string): NmYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = NM_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(NM_WITHHOLDING, year);
  }
  return rates;
}

function nmPeriodFor(periodsPerYear: number): NmPeriod {
  const period = payPeriodFor(periodsPerYear);
  // The daily tables are 260-calibrated (single $61.90 = $16,100 ÷ 260), so
  // a 365-day daily payroll has no printed table — refused like the KS/MO
  // daily guards refuse theirs.
  if (period == null || (period === "daily" && periodsPerYear !== 260)) {
    refuseUnprintedPeriod(NM_WITHHOLDING, periodsPerYear);
  }
  return period as NmPeriod;
}

/**
 * Which column applies, from the W-4 copy held for New Mexico purposes.
 *
 * FYI-104 p. 4: "In the case of a married employee who has elected
 * withholding at the higher single rate for federal purposes, the single
 * rate for New Mexico state withholding purposes must also be used."
 *
 * With NO certificate at all FYI-104 states no default column — but the
 * tables' own (a) column is headed "SINGLE person", and withholding a
 * no-certificate employee from the single column is the publication's
 * structure, not an engine guess: there is no fourth column to fall back
 * to. Recorded as a choice, not a citation (the New Jersey engine records
 * the same class of decision the same way).
 */
export function nmScheduleFor(input: {
  filingStatus: string | null;
  higherSingleRate: boolean;
}): NmFilingStatus {
  if (input.higherSingleRate) return "single";
  switch (input.filingStatus) {
    case "married":
      return "married";
    case "head_household":
      return "head_household";
    default:
      return "single";
  }
}

/** Find the printed line: over the first column, NOT over the second. */
function rowFor(table: NmPeriodTable, wages: bigint): NmRow | null {
  for (const row of table.rows) {
    const over = U(row.over);
    // The bottom line is printed "Not Over $N → $0.00", and a zero-wage
    // payroll has to land somewhere: treat the bottom of the schedule as
    // inclusive of zero.
    const aboveFloor = over === 0n ? wages >= 0n : wages > over;
    if (!aboveFloor) continue;
    if (row.butNotOver == null || wages <= U(row.butNotOver)) return row;
  }
  return null;
}

/**
 * FYI-104 p. 4: "If the federal withholding is calculated using a flat
 * percent, a flat 5.9% of the supplemental wage or fringe benefit amount
 * should be withheld for state tax purposes." For the caller that knows a
 * supplemental payment stood alone from regular wages.
 */
export function nmSupplementalFlat(
  supplemental: string,
  rates: NmYearRates = NM_RATES_2026,
): string {
  return D(mulRateCents(U(supplemental), rates.supplementalRate));
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = nmRatesForPayDate(input.payDate);
  const period = nmPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // Step 4(c) on the 2020-or-later federal W-4, which FYI-104 p. 2 names as
  // the exempt-income path (tribal-land and active-duty military wages).
  if (certificateFlag(input.certificate, "exempt")) {
    trace("NM_EXEMPT", 1n);
    return { state: "NM", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const status = nmScheduleFor({
    filingStatus: certificateChoice(input.certificate, "filing_status"),
    higherSingleRate: certificateFlag(input.certificate, "higher_single_rate"),
  });
  factors.NM_STATUS = status;

  const schedule = rates.tables[status][period];

  // FYI-104's supplemental rule keys off the FEDERAL method for a payment
  // made separately from regular wages — a separate payment this engine is
  // not told about, so it is not silently assumed. Wages handed in together
  // are tabled together (the federal combined method), and
  // `taxSupplemental` stays zero for that reason. Same shape as NJ.
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  trace("NM_WAGES", wages);

  const row = rowFor(schedule, wages);
  if (!row) {
    // Reachable ONLY through a defect in the state's own printed table: no
    // FYI-104 schedule leaves a gap, but if one did, the rate for a wage no
    // line covers is not something an engine gets to invent, and withholding
    // nothing would be a silent zero. The New Jersey engine refuses the same
    // way for its one printed hole.
    throw new PayrollError(
      `no New Mexico FYI-104 Table line covers wages of ${D(wages)} on a `
      + `${period} payroll for a ${status} employee. The state's printed table leaves a gap there; `
      + `see ${RATES_MODULE} and the conformance test, and confirm the bracket with the Taxation `
      + "and Revenue Department before paying this employee.",
    );
  }
  factors.NM_BRACKET_RATE = row.printedPercent;
  const tableTax = U(row.base) + mulRateCents(wages - U(row.ofExcessOver), row.rate);
  trace("NM_TABLE_TAX", tableTax);

  // FYI-104 p. 3: additional state withholding "may be done on the W-4 kept
  // for New Mexico withholding purposes" — a flat amount added AFTER the
  // schedule, not tabled by it (the worked example adds the $20.00 last).
  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const total = tableTax + extra;

  // FYI-104 p. 2: "No withholding is required if the total withholding for
  // an employee during any one month is less than one dollar." Only a
  // monthly payroll's total is visible here — any other frequency's month
  // aggregates periods the engine never sees, so the rule applies where it
  // is decidable and nowhere else.
  if (period === "monthly" && total < U("1")) {
    trace("NM_DE_MINIMIS", total);
    return { state: "NM", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }
  trace("NM_WITHHELD", total);

  return {
    state: "NM",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above. Terms are the FYI-104 percentage method's own — see the
 * module header.
 */
export const NM_FACTOR_LABELS: Readonly<Record<string, string>> = {
  NM_EXEMPT: "Exempt from New Mexico withholding (FYI-104 exempt-income path)",
  NM_WAGES: "New Mexico wages this period",
  NM_STATUS: "New Mexico filing status",
  NM_BRACKET_RATE: "New Mexico bracket rate (printed percent)",
  NM_TABLE_TAX: "New Mexico table tax",
  NM_DE_MINIMIS: "New Mexico de minimis (monthly under $1, no withholding)",
  NM_WITHHELD: "New Mexico tax withheld this period",
};

export const NM_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NM",
  label: "New Mexico withholding tax",
  certificateKey: "us_nm_w4",
  ratesModule: RATES_MODULE,
  editions: NM_TAX_YEAR_EDITIONS,
  // FYI-104 prints all eight Tables 1–8, so any standard frequency has a
  // real table.
  printedPeriods: NM_PERIODS,
  compute,
};

// ===========================================================================
// Declarations
// ===========================================================================

/**
 * New Mexico withholding declarations — the W-4 copy and the state region.
 *
 * Wired into `us/jurisdictions.ts` beside every other region's
 * declaration. The engine's `compute` reads answers through
 * `ResolvedCertificate`, never these constants.
 */
/**
 * There is no New Mexico equivalent of the federal W-4 (FYI-104 p. 2):
 * "employees should complete a copy of the Federal Form W-4 for New Mexico
 * withholding tax purposes, writing 'For New Mexico State Withholding Only'
 * across the top in prominent letters." These fields store the answers the
 * employer actually uses from that copy: the Step 1(c) filing status (which
 * picks the table column), the higher-single-rate election (which moves a
 * married employee to the single column), Step 4(c) additional and exempt.
 */
export const NM_CERTIFICATE: PayrollCertificate = {
  key: "us_nm_w4",
  form: "W-4 (New Mexico copy)",
  label: "Employee's Withholding Certificate — copy held for New Mexico",
  scope: { level: "region", region: "NM" },
  purpose: "withholding",
  citation:
    "New Mexico Taxation and Revenue Department, FYI-104 New Mexico Withholding Tax, "
    + "REV. 11/2025, pp. 2–4",
  summary:
    "The federal W-4 answers New Mexico withholds on: there is no state form, so the "
    + "employer keeps a copy of the federal W-4 marked for New Mexico purposes. The "
    + "filing status picks the FYI-104 table column; a married employee at the higher "
    + "single rate uses the single column.",
  storage: "certificate_rows",
  fields: [
    {
      key: "filing_status",
      label: "Filing status (FYI-104 table column)",
      kind: "choice",
      default: "single",
      choices: [
        { value: "single", label: "Single — column (a)" },
        { value: "married", label: "Married — column (b)" },
        { value: "head_household", label: "Head of household — column (c)" },
      ],
      help:
        "As checked in Step 1(c) of the W-4 copy. Default Single is the tables' own "
        + "(a) column for an employee with nothing on file, not an engine guess.",
    },
    {
      key: "higher_single_rate",
      label: "Withhold at the higher single rate",
      kind: "flag",
      help:
        "FYI-104 p. 4: a married employee who elected the higher single rate for "
        + "federal purposes uses the SINGLE column for New Mexico too.",
    },
    {
      key: "additional_per_period",
      label: "Additional New Mexico withholding per pay period",
      kind: "amount",
      decimals: 4,
      min: "0",
      help:
        "FYI-104 p. 3: additional state withholding requested on the W-4 copy. "
        + "Added AFTER the schedule — the worked example adds its $20.00 last.",
    },
    {
      key: "exempt",
      label: "Exempt from New Mexico withholding (Step 4(c))",
      kind: "flag",
      help:
        "FYI-104 p. 2: employees whose income is exempt from New Mexico tax (tribal-land "
        + "wages, active-duty military pay) claim it through Step 4(c) of the 2020-or-later "
        + "W-4. A current exempt flag withholds zero.",
    },
  ],
};

export const NM_REGION: PayrollRegionWithholding = {
  region: "NM",
  label: "New Mexico withholding tax",
  implemented: true,
  // FYI-104 p. 2: a nonresident who "performs services within the state for
  // an employer" is an employee, and withholding reaches "only ... wages
  // the employee earns within the state". The 15-or-fewer-days exception
  // needs a day count this engine is not given — noted in nm.ts, not
  // computed.
  taxesNonresidentWages: true,
  // FYI-104 p. 2: "For New Mexico residents, the employer is required to
  // withhold New Mexico income tax from all wages of the employee regardless
  // of the employee's work location." FYI-104 p. 4: where another state
  // taxes the same wages, "New Mexico allows a credit for the other state's
  // income tax" on the return — computed elsewhere, so declared and refused.
  residentWithholding: "required_net_of_credit",
  residentWithholdingImplemented: false,
  certificateKey: "us_nm_w4",
  // New Mexico levies no local wage income tax.
  subRegions: [],
  subRegionConflictRule: "both",
  citation:
    "New Mexico Taxation and Revenue Department, FYI-104 New Mexico Withholding Tax, "
    + "REV. 11/2025 — Tables 1–8 for wages paid on or after January 1, 2026",
};
