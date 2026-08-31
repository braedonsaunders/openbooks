/**
 * New York withholding — New York State, New York City, and Yonkers.
 *
 * Sources (fetched from tax.ny.gov, not memory):
 *   NYS-50-T-NYS (1/26), New York State Withholding Tax Tables and Methods,
 *     effective January 1 – December 31, 2026. Method II (Exact Calculation)
 *     pp. 16–19, special allowance Tables A–D p. 14, Method III p. 22.
 *   NYS-50-T-NYC (1/26), New York City Withholding Tax Tables and Methods.
 *     Method II pp. 24–27.
 *   NYS-50-T-Y (1/26), Yonkers Withholding Tax Tables and Methods. Resident
 *     surcharge Methods I–III; nonresident earnings tax Methods VI–VIII.
 *   Publication NYS-50 (12/23), Employer's Guide, parts G–K and P.
 *   Form IT-2104 (2026) and IT-2104.1 (12/24).
 *
 * ---------------------------------------------------------------------------
 * Three structural facts that shape this module
 * ---------------------------------------------------------------------------
 * 1. NEW YORK'S METHOD II DOES NOT ANNUALIZE. Every payroll period has its own
 *    pre-scaled bracket table. Only Method III — the top-rates method above
 *    $1,077,550 single / $2,155,350 married of annualized net wages —
 *    annualizes, and it applies a FLAT rate to the WHOLE annualized wage rather
 *    than to an excess. The printed per-period tables' rounded "and over"
 *    handoff is authoritative where it falls fractionally below that annualized
 *    threshold. Deriving the weekly table by dividing the annual one reproduces
 *    neither.
 *
 * 2. THE RECAPTURE IS INSIDE THE SCHEDULE. New York's marginal rates are NOT
 *    monotonic: the single schedule runs 6.40% then 11.44% then back to 7.35%,
 *    and the married one 6.40% then 13.49% then 7.35%. Those spikes are the
 *    supplemental-tax recapture that claws back the benefit of the lower
 *    brackets. There is no separate recapture table to add — a fact worth
 *    stating plainly, because looking for one and not finding it is how a
 *    system ends up under-withholding six figures of income by design.
 *
 * 3. YONKERS RESIDENT TAX IS A SURCHARGE ON THE STATE TAX, not a tax on wages:
 *    16.75% of the New York State withholding. NYS-50-T-Y reprints the entire
 *    NYS schedule with "× 0.1675" appended to step 5, and the two are
 *    byte-identical. This module therefore does NOT transcribe the Yonkers
 *    tables a second time; it multiplies. A second copy of a schedule is a
 *    second thing to keep in step, and it would be out of step within a year.
 *
 * ---------------------------------------------------------------------------
 * Rounding
 * ---------------------------------------------------------------------------
 * Every one of the publications' worked examples rounds the step-4 product to
 * the CENT before adding column 5. Full precision carried to the end gives a
 * different final cent in several of them. `mulRateCents` rounds half-up to the
 * cent in one step, which is the rule 21 of the 24 printed examples follow.
 *
 * The other three do not follow ANY single rule, and they are transcribed into
 * the conformance test with the discrepancy documented rather than quietly
 * dropped — see ny.test.ts. Two round away from half-up in opposite directions
 * and one carries a rate typo the table itself contradicts. Chasing them would
 * mean encoding "round up on Tuesdays"; ignoring them silently would mean
 * nobody ever learns the state's own examples disagree with the state's own
 * tables.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount,
} from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import {
  payPeriodFor,
  refuseUnprintedPeriod,
  refuseUntranscribedYear,
  type UsStatePayPeriod,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/ny.ts";

/** The two schedules every New York publication prints. */
type NyMarital = "single" | "married";

/** The pay periods New York publishes Method II tables for. */
type NyPeriod = "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly" | "annual";

const NY_PERIODS: readonly UsStatePayPeriod[] = [
  "daily", "weekly", "biweekly", "semimonthly", "monthly", "annual",
];

/**
 * One Method II line: for net wages at least `atLeast` and less than
 * `butLessThan`, tax = (net − subtract) × rate + add.
 *
 * The boundaries are HALF-OPEN — column 1 is "At least" (inclusive) and column
 * 2 is "But less than" (exclusive) — which matters at every breakpoint.
 */
interface NyRow {
  atLeast: string;
  butLessThan: string | null;
  subtract: string;
  rate: string;
  add: string;
}

/** Table A, B, C — the deduction and exemption allowances. */
interface NyAllowanceTables {
  /** Table A: combined deduction + exemption, indexed by exemptions 0…10. */
  combined: Readonly<Record<NyPeriod, Readonly<Record<NyMarital, readonly string[]>>>>;
  /** Table B: the deduction allowance alone, for more than 10 exemptions. */
  deduction: Readonly<Record<NyPeriod, Readonly<Record<NyMarital, string>>>>;
  /** Table C: one exemption. "Based on a full year exemption of $1,000." */
  exemption: Readonly<Record<NyPeriod, string>>;
}

interface NyMethodIIIBand {
  atLeast: string;
  rate: string;
}

export interface NyYearRates {
  year: number;
  status: "published" | "draft";
  nys: {
    allowances: NyAllowanceTables;
    tables: Readonly<Record<NyPeriod, Readonly<Record<NyMarital, readonly NyRow[]>>>>;
    /** Annualized net wages at or above which Method III replaces Method II. */
    methodIIIThreshold: Readonly<Record<NyMarital, string>>;
    methodIII: Readonly<Record<NyMarital, readonly NyMethodIIIBand[]>>;
    supplementalRate: string;
  };
  nyc: {
    allowances: NyAllowanceTables;
    /**
     * NYC prints a Single table and a Married table and they are BYTE-IDENTICAL
     * — every column of every line, in all six payroll periods. Filing status
     * reaches New York City withholding only through the Table A allowance
     * lookup. One table is stored, and a conformance test pins the finding so a
     * future edition that diverges is caught rather than absorbed.
     */
    tables: Readonly<Record<NyPeriod, readonly NyRow[]>>;
    supplementalRate: string;
  };
  yonkers: {
    /** The resident surcharge, as a fraction of the NYS withholding. */
    residentSurcharge: string;
    /** The nonresident earnings tax rate on Yonkers-source gross wages. */
    nonresidentRate: string;
    /** Method VII: per-period gross-wage bands and their exclusions. */
    nonresidentBands: Readonly<Record<NyPeriod, readonly {
      atLeast: string; butLessThan: string | null; exclusion: string | null;
    }[]>>;
    supplementalResidentRate: string;
    supplementalNonresidentRate: string;
  };
}

// ---------------------------------------------------------------------------
// NYS-50-T-NYS (1/26) p. 14 — Tables A, B, C
// ---------------------------------------------------------------------------
const NYS_ALLOWANCES: NyAllowanceTables = {
  combined: {
    daily: {
      single: ["28.45", "32.30", "36.15", "40.00", "43.85", "47.70", "51.55", "55.40", "59.25", "63.10", "66.95"],
      married: ["30.60", "34.45", "38.30", "42.15", "46.00", "49.85", "53.70", "57.55", "61.40", "65.25", "69.10"],
    },
    weekly: {
      single: ["142.30", "161.55", "180.80", "200.05", "219.30", "238.55", "257.80", "277.05", "296.30", "315.55", "334.80"],
      married: ["152.90", "172.15", "191.40", "210.65", "229.90", "249.15", "268.40", "287.65", "306.90", "326.15", "345.40"],
    },
    biweekly: {
      single: ["284.60", "323.10", "361.60", "400.10", "438.60", "477.10", "515.60", "554.10", "592.60", "631.10", "669.60"],
      married: ["305.80", "344.30", "382.80", "421.30", "459.80", "498.30", "536.80", "575.30", "613.80", "652.30", "690.80"],
    },
    semimonthly: {
      single: ["308.35", "350.00", "391.65", "433.30", "474.95", "516.60", "558.25", "599.90", "641.55", "683.20", "724.85"],
      married: ["331.25", "372.90", "414.55", "456.20", "497.85", "539.50", "581.15", "622.80", "664.45", "706.10", "747.75"],
    },
    monthly: {
      single: ["616.70", "700.00", "783.30", "866.60", "949.90", "1033.20", "1116.50", "1199.80", "1283.10", "1366.40", "1449.70"],
      married: ["662.50", "745.80", "829.10", "912.40", "995.70", "1079.00", "1162.30", "1245.60", "1328.90", "1412.20", "1495.50"],
    },
    annual: {
      single: ["7400", "8400", "9400", "10400", "11400", "12400", "13400", "14400", "15400", "16400", "17400"],
      married: ["7950", "8950", "9950", "10950", "11950", "12950", "13950", "14950", "15950", "16950", "17950"],
    },
  },
  deduction: {
    daily: { single: "28.45", married: "30.60" },
    weekly: { single: "142.30", married: "152.90" },
    biweekly: { single: "284.60", married: "305.80" },
    semimonthly: { single: "308.35", married: "331.25" },
    monthly: { single: "616.70", married: "662.50" },
    annual: { single: "7400", married: "7950" },
  },
  exemption: {
    daily: "3.85", weekly: "19.25", biweekly: "38.50",
    semimonthly: "41.65", monthly: "83.30", annual: "1000",
  },
};

/** Build Method II lines from the printed five columns. */
function nyRows(
  lines: readonly (readonly [string, string | null, string, string, string])[],
): readonly NyRow[] {
  return lines.map(([atLeast, butLessThan, subtract, rate, add]) =>
    ({ atLeast, butLessThan, subtract, rate, add }));
}

// NYS-50-T-NYS (1/26) p. 17 — SINGLE.
const NYS_SINGLE: Readonly<Record<NyPeriod, readonly NyRow[]>> = {
  weekly: nyRows([
    ["0", "163", "0", "0.0390", "0"],
    ["163", "225", "163", "0.0440", "6.38"],
    ["225", "267", "225", "0.0515", "9.08"],
    ["267", "1551", "267", "0.0540", "11.27"],
    ["1551", "1862", "1551", "0.0590", "80.58"],
    ["1862", "2070", "1862", "0.0703", "98.90"],
    ["2070", "3032", "2070", "0.0753", "113.58"],
    ["3032", "4142", "3032", "0.0640", "186.02"],
    ["4142", "5104", "4142", "0.1144", "257.10"],
    ["5104", "20722", "5104", "0.0735", "367.13"],
  ]),
  biweekly: nyRows([
    ["0", "327", "0", "0.0390", "0"],
    ["327", "450", "327", "0.0440", "12.77"],
    ["450", "535", "450", "0.0515", "18.15"],
    ["535", "3102", "535", "0.0540", "22.54"],
    ["3102", "3723", "3102", "0.0590", "161.15"],
    ["3723", "4140", "3723", "0.0703", "197.81"],
    ["4140", "6063", "4140", "0.0753", "227.15"],
    ["6063", "8285", "6063", "0.0640", "372.04"],
    ["8285", "10208", "8285", "0.1144", "514.19"],
    ["10208", "41444", "10208", "0.0735", "734.27"],
  ]),
  semimonthly: nyRows([
    ["0", "354", "0", "0.0390", "0"],
    ["354", "488", "354", "0.0440", "13.83"],
    ["488", "579", "488", "0.0515", "19.67"],
    ["579", "3360", "579", "0.0540", "24.42"],
    ["3360", "4033", "3360", "0.0590", "174.58"],
    ["4033", "4485", "4033", "0.0703", "214.29"],
    ["4485", "6569", "4485", "0.0753", "246.08"],
    ["6569", "8975", "6569", "0.0640", "403.04"],
    ["8975", "11058", "8975", "0.1144", "557.04"],
    ["11058", "44898", "11058", "0.0735", "795.46"],
  ]),
  monthly: nyRows([
    ["0", "708", "0", "0.0390", "0"],
    ["708", "975", "708", "0.0440", "27.67"],
    ["975", "1158", "975", "0.0515", "39.33"],
    ["1158", "6721", "1158", "0.0540", "48.83"],
    ["6721", "8067", "6721", "0.0590", "349.17"],
    ["8067", "8971", "8067", "0.0703", "428.58"],
    ["8971", "13138", "8971", "0.0753", "492.17"],
    ["13138", "17950", "13138", "0.0640", "806.08"],
    ["17950", "22117", "17950", "0.1144", "1114.08"],
    ["22117", "89796", "22117", "0.0735", "1590.92"],
  ]),
  daily: nyRows([
    ["0", "33", "0", "0.0390", "0"],
    ["33", "45", "33", "0.0440", "1.28"],
    ["45", "53", "45", "0.0515", "1.82"],
    ["53", "310", "53", "0.0540", "2.25"],
    ["310", "372", "310", "0.0590", "16.12"],
    ["372", "414", "372", "0.0703", "19.78"],
    ["414", "606", "414", "0.0753", "22.72"],
    ["606", "828", "606", "0.0640", "37.20"],
    ["828", "1021", "828", "0.1144", "51.42"],
    ["1021", "4144", "1021", "0.0735", "73.43"],
  ]),
  annual: nyRows([
    ["0", "8500", "0", "0.0390", "0"],
    ["8500", "11700", "8500", "0.0440", "332.00"],
    ["11700", "13900", "11700", "0.0515", "472.00"],
    ["13900", "80650", "13900", "0.0540", "586.00"],
    ["80650", "96800", "80650", "0.0590", "4190.00"],
    ["96800", "107650", "96800", "0.0703", "5143.00"],
    ["107650", "157650", "107650", "0.0753", "5906.00"],
    ["157650", "215400", "157650", "0.0640", "9673.00"],
    ["215400", "265400", "215400", "0.1144", "13369.00"],
    ["265400", "1077550", "265400", "0.0735", "19091.00"],
  ]),
};

// NYS-50-T-NYS (1/26) p. 19 — MARRIED.
const NYS_MARRIED: Readonly<Record<NyPeriod, readonly NyRow[]>> = {
  weekly: nyRows([
    ["0", "163", "0", "0.0390", "0"],
    ["163", "225", "163", "0.0440", "6.38"],
    ["225", "267", "225", "0.0515", "9.08"],
    ["267", "1551", "267", "0.0540", "11.27"],
    ["1551", "1862", "1551", "0.0590", "80.58"],
    ["1862", "2070", "1862", "0.0657", "98.90"],
    ["2070", "3032", "2070", "0.0707", "112.60"],
    ["3032", "4068", "3032", "0.0801", "180.54"],
    ["4068", "6215", "4068", "0.0640", "263.62"],
    ["6215", "7177", "6215", "0.1349", "401.04"],
    ["7177", "20722", "7177", "0.0735", "530.77"],
    ["20722", "41449", "20722", "0.0765", "1526.33"],
  ]),
  biweekly: nyRows([
    ["0", "327", "0", "0.0390", "0"],
    ["327", "450", "327", "0.0440", "12.77"],
    ["450", "535", "450", "0.0515", "18.15"],
    ["535", "3102", "535", "0.0540", "22.54"],
    ["3102", "3723", "3102", "0.0590", "161.15"],
    ["3723", "4140", "3723", "0.0657", "197.81"],
    ["4140", "6063", "4140", "0.0707", "225.19"],
    ["6063", "8137", "6063", "0.0801", "361.08"],
    ["8137", "12431", "8137", "0.0640", "527.23"],
    ["12431", "14354", "12431", "0.1349", "802.08"],
    ["14354", "41444", "14354", "0.0735", "1061.54"],
    ["41444", "82898", "41444", "0.0765", "3052.65"],
  ]),
  semimonthly: nyRows([
    ["0", "354", "0", "0.0390", "0"],
    ["354", "488", "354", "0.0440", "13.83"],
    ["488", "579", "488", "0.0515", "19.67"],
    ["579", "3360", "579", "0.0540", "24.42"],
    ["3360", "4033", "3360", "0.0590", "174.58"],
    ["4033", "4485", "4033", "0.0657", "214.29"],
    ["4485", "6569", "4485", "0.0707", "243.96"],
    ["6569", "8815", "6569", "0.0801", "391.17"],
    ["8815", "13467", "8815", "0.0640", "571.17"],
    ["13467", "15550", "13467", "0.1349", "868.92"],
    ["15550", "44898", "15550", "0.0735", "1150.00"],
    ["44898", "89806", "44898", "0.0765", "3307.04"],
  ]),
  monthly: nyRows([
    ["0", "708", "0", "0.0390", "0"],
    ["708", "975", "708", "0.0440", "27.67"],
    ["975", "1158", "975", "0.0515", "39.33"],
    ["1158", "6721", "1158", "0.0540", "48.83"],
    ["6721", "8067", "6721", "0.0590", "349.17"],
    ["8067", "8971", "8067", "0.0657", "428.58"],
    ["8971", "13138", "8971", "0.0707", "487.92"],
    ["13138", "17629", "13138", "0.0801", "782.33"],
    ["17629", "26933", "17629", "0.0640", "1142.33"],
    ["26933", "31100", "26933", "0.1349", "1737.83"],
    ["31100", "89796", "31100", "0.0735", "2300.00"],
    ["89796", "179613", "89796", "0.0765", "6614.08"],
  ]),
  daily: nyRows([
    ["0", "33", "0", "0.0390", "0"],
    ["33", "45", "33", "0.0440", "1.28"],
    ["45", "53", "45", "0.0515", "1.82"],
    ["53", "310", "53", "0.0540", "2.25"],
    ["310", "372", "310", "0.0590", "16.12"],
    ["372", "414", "372", "0.0657", "19.78"],
    ["414", "606", "414", "0.0707", "22.52"],
    ["606", "814", "606", "0.0801", "36.11"],
    ["814", "1243", "814", "0.0640", "52.72"],
    ["1243", "1435", "1243", "0.1349", "80.21"],
    ["1435", "4144", "1435", "0.0735", "106.15"],
    ["4144", "8290", "4144", "0.0765", "305.27"],
  ]),
  annual: nyRows([
    ["0", "8500", "0", "0.0390", "0"],
    ["8500", "11700", "8500", "0.0440", "332.00"],
    ["11700", "13900", "11700", "0.0515", "472.00"],
    ["13900", "80650", "13900", "0.0540", "586.00"],
    ["80650", "96800", "80650", "0.0590", "4190.00"],
    ["96800", "107650", "96800", "0.0657", "5143.00"],
    ["107650", "157650", "107650", "0.0707", "5855.00"],
    ["157650", "211550", "157650", "0.0801", "9388.00"],
    ["211550", "323200", "211550", "0.0640", "13708.00"],
    ["323200", "373200", "323200", "0.1349", "20854.00"],
    ["373200", "1077550", "373200", "0.0735", "27600.00"],
    ["1077550", "2155350", "1077550", "0.0765", "79369.00"],
  ]),
};

// ---------------------------------------------------------------------------
// NYS-50-T-NYC (1/26) p. 24 — Tables A, B, C
// ---------------------------------------------------------------------------
const NYC_ALLOWANCES: NyAllowanceTables = {
  combined: {
    daily: {
      single: ["19.25", "23.10", "26.95", "30.80", "34.65", "38.50", "42.35", "46.20", "50.05", "53.90", "57.75"],
      married: ["21.15", "25.00", "28.85", "32.70", "36.55", "40.40", "44.25", "48.10", "51.95", "55.80", "59.65"],
    },
    weekly: {
      single: ["96.15", "115.40", "134.65", "153.90", "173.15", "192.40", "211.65", "230.90", "250.15", "269.40", "288.65"],
      married: ["105.75", "125.00", "144.25", "163.50", "182.75", "202.00", "221.25", "240.50", "259.75", "279.00", "298.25"],
    },
    biweekly: {
      single: ["192.30", "230.80", "269.30", "307.80", "346.30", "384.80", "423.30", "461.80", "500.30", "538.80", "577.30"],
      married: ["211.50", "250.00", "288.50", "327.00", "365.50", "404.00", "442.50", "481.00", "519.50", "558.00", "596.50"],
    },
    semimonthly: {
      single: ["208.35", "250.00", "291.65", "333.30", "374.95", "416.60", "458.25", "499.90", "541.55", "583.20", "624.85"],
      married: ["229.15", "270.80", "312.45", "354.10", "395.75", "437.40", "479.05", "520.70", "562.35", "604.00", "645.65"],
    },
    monthly: {
      single: ["416.70", "500.00", "583.30", "666.60", "749.90", "833.20", "916.50", "999.80", "1083.10", "1166.40", "1249.70"],
      married: ["458.30", "541.60", "624.90", "708.20", "791.50", "874.80", "958.10", "1041.40", "1124.70", "1208.00", "1291.30"],
    },
    annual: {
      single: ["5000", "6000", "7000", "8000", "9000", "10000", "11000", "12000", "13000", "14000", "15000"],
      married: ["5500", "6500", "7500", "8500", "9500", "10500", "11500", "12500", "13500", "14500", "15500"],
    },
  },
  deduction: {
    daily: { single: "19.25", married: "21.15" },
    weekly: { single: "96.15", married: "105.75" },
    biweekly: { single: "192.30", married: "211.50" },
    semimonthly: { single: "208.35", married: "229.15" },
    monthly: { single: "416.70", married: "458.30" },
    annual: { single: "5000", married: "5500" },
  },
  exemption: {
    daily: "3.85", weekly: "19.25", biweekly: "38.50",
    semimonthly: "41.65", monthly: "83.30", annual: "1000",
  },
};

// NYS-50-T-NYC (1/26) pp. 25–26. One table: the printed Single and Married
// schedules are identical line for line.
const NYC_TABLES: Readonly<Record<NyPeriod, readonly NyRow[]>> = {
  weekly: nyRows([
    ["0", "154", "0", "0.0205", "0"],
    ["154", "167", "154", "0.0280", "3.15"],
    ["167", "288", "167", "0.0325", "3.54"],
    ["288", "481", "288", "0.0395", "7.46"],
    ["481", "1154", "481", "0.0415", "15.06"],
    ["1154", null, "1154", "0.0425", "43.00"],
  ]),
  biweekly: nyRows([
    ["0", "308", "0", "0.0205", "0"],
    ["308", "334", "308", "0.0280", "6.31"],
    ["334", "577", "334", "0.0325", "7.08"],
    ["577", "962", "577", "0.0395", "14.92"],
    ["962", "2308", "962", "0.0415", "30.12"],
    ["2308", null, "2308", "0.0425", "86.00"],
  ]),
  semimonthly: nyRows([
    ["0", "333", "0", "0.0205", "0"],
    ["333", "362", "333", "0.0280", "6.83"],
    ["362", "625", "362", "0.0325", "7.67"],
    ["625", "1042", "625", "0.0395", "16.17"],
    ["1042", "2500", "1042", "0.0415", "32.63"],
    ["2500", null, "2500", "0.0425", "93.17"],
  ]),
  monthly: nyRows([
    ["0", "667", "0", "0.0205", "0"],
    ["667", "725", "667", "0.0280", "13.67"],
    ["725", "1250", "725", "0.0325", "15.33"],
    ["1250", "2083", "1250", "0.0395", "32.33"],
    ["2083", "5000", "2083", "0.0415", "65.25"],
    ["5000", null, "5000", "0.0425", "186.33"],
  ]),
  daily: nyRows([
    ["0.00", "31.00", "0.00", "0.0205", "0"],
    ["31.00", "33.50", "31.00", "0.0280", "0.63"],
    ["33.50", "57.50", "33.50", "0.0325", "0.71"],
    ["57.50", "96.00", "57.50", "0.0395", "1.49"],
    ["96.00", "231.00", "96.00", "0.0415", "3.01"],
    ["231.00", null, "231.00", "0.0425", "8.60"],
  ]),
  annual: nyRows([
    ["0", "8000", "0", "0.0205", "0"],
    ["8000", "8700", "8000", "0.0280", "164.00"],
    ["8700", "15000", "8700", "0.0325", "184.00"],
    ["15000", "25000", "15000", "0.0395", "388.00"],
    ["25000", "60000", "25000", "0.0415", "783.00"],
    ["60000", null, "60000", "0.0425", "2236.00"],
  ]),
};

// NYS-50-T-Y (1/26) p. 24, Method VII — the nonresident earnings tax bands.
// The base is GROSS wages: the nonresident earnings tax does not use Table A.
const YONKERS_NONRESIDENT_BANDS: NyYearRates["yonkers"]["nonresidentBands"] = {
  weekly: [
    { atLeast: "0", butLessThan: "77", exclusion: null },
    { atLeast: "77", butLessThan: "192", exclusion: "58" },
    { atLeast: "192", butLessThan: "385", exclusion: "38" },
    { atLeast: "385", butLessThan: "577", exclusion: "19" },
    { atLeast: "577", butLessThan: null, exclusion: "0" },
  ],
  biweekly: [
    { atLeast: "0", butLessThan: "154", exclusion: null },
    { atLeast: "154", butLessThan: "385", exclusion: "115" },
    { atLeast: "385", butLessThan: "769", exclusion: "77" },
    { atLeast: "769", butLessThan: "1154", exclusion: "38" },
    { atLeast: "1154", butLessThan: null, exclusion: "0" },
  ],
  semimonthly: [
    { atLeast: "0", butLessThan: "167", exclusion: null },
    { atLeast: "167", butLessThan: "417", exclusion: "125" },
    { atLeast: "417", butLessThan: "833", exclusion: "83" },
    { atLeast: "833", butLessThan: "1250", exclusion: "42" },
    { atLeast: "1250", butLessThan: null, exclusion: "0" },
  ],
  monthly: [
    { atLeast: "0", butLessThan: "333", exclusion: null },
    { atLeast: "333", butLessThan: "833", exclusion: "250" },
    { atLeast: "833", butLessThan: "1667", exclusion: "167" },
    { atLeast: "1667", butLessThan: "2500", exclusion: "83" },
    { atLeast: "2500", butLessThan: null, exclusion: "0" },
  ],
  daily: [
    { atLeast: "0", butLessThan: "15", exclusion: null },
    { atLeast: "15", butLessThan: "38", exclusion: "12" },
    { atLeast: "38", butLessThan: "77", exclusion: "8" },
    { atLeast: "77", butLessThan: "115", exclusion: "4" },
    { atLeast: "115", butLessThan: null, exclusion: "0" },
  ],
  // Method VIII's annualized schedule, expressed at the annual period so the
  // one lookup serves both. NYS-50-T-Y (1/26) p. 25.
  // Line 1 is printed as "over $0 but not over $3,999.99", so annualized pay of
  // exactly $4,000.00 falls in line 2 and is withheld on. Transcribed to the
  // cent rather than rounded to $4,000, which would move that dollar into the
  // no-withholding band.
  annual: [
    { atLeast: "0", butLessThan: "3999.99", exclusion: null },
    { atLeast: "3999.99", butLessThan: "10000", exclusion: "3000" },
    { atLeast: "10000", butLessThan: "20000", exclusion: "2000" },
    { atLeast: "20000", butLessThan: "30000", exclusion: "1000" },
    { atLeast: "30000", butLessThan: null, exclusion: "0" },
  ],
};

export const NY_RATES_2026: NyYearRates = {
  year: 2026,
  status: "published",
  nys: {
    allowances: NYS_ALLOWANCES,
    tables: {
      weekly: { single: NYS_SINGLE.weekly, married: NYS_MARRIED.weekly },
      biweekly: { single: NYS_SINGLE.biweekly, married: NYS_MARRIED.biweekly },
      semimonthly: { single: NYS_SINGLE.semimonthly, married: NYS_MARRIED.semimonthly },
      monthly: { single: NYS_SINGLE.monthly, married: NYS_MARRIED.monthly },
      daily: { single: NYS_SINGLE.daily, married: NYS_MARRIED.daily },
      annual: { single: NYS_SINGLE.annual, married: NYS_MARRIED.annual },
    },
    methodIIIThreshold: { single: "1077550", married: "2155350" },
    methodIII: {
      single: [
        { atLeast: "1077550", rate: "0.1045" },
        { atLeast: "5000000", rate: "0.1110" },
        { atLeast: "25000000", rate: "0.1170" },
      ],
      married: [
        { atLeast: "2155350", rate: "0.1045" },
        { atLeast: "5000000", rate: "0.1110" },
        { atLeast: "25000000", rate: "0.1170" },
      ],
    },
    supplementalRate: "0.1170",
  },
  nyc: {
    allowances: NYC_ALLOWANCES,
    tables: NYC_TABLES,
    supplementalRate: "0.0425",
  },
  yonkers: {
    residentSurcharge: "0.1675",
    nonresidentRate: "0.0050",
    nonresidentBands: YONKERS_NONRESIDENT_BANDS,
    // 1.95975% is exactly 11.70% × 16.75% — the publications are internally
    // consistent, and the conformance test proves it rather than trusting it.
    supplementalResidentRate: "0.0195975",
    supplementalNonresidentRate: "0.0050",
  },
};

const NY_EDITIONS_BY_YEAR: Record<number, NyYearRates> = {
  [NY_RATES_2026.year]: NY_RATES_2026,
};

export const NY_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "NYS-50-T-NYS / NYS-50-T-NYC / NYS-50-T-Y (1/26)",
  effectiveFrom: "2026-01-01",
  citation:
    "NYS Department of Taxation and Finance, NYS-50-T-NYS (1/26) Method II and Method III; "
    + "NYS-50-T-NYC (1/26) Method II; NYS-50-T-Y (1/26) resident surcharge and Methods VII–VIII",
  status: "published",
  region: "NY",
}];

export function nyRatesForPayDate(payDate: string): NyYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = NY_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(NY_WITHHOLDING, year);
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Shared mechanics
// ---------------------------------------------------------------------------

function nyPeriodFor(periodsPerYear: number): NyPeriod {
  const period = payPeriodFor(periodsPerYear);
  if (period == null || !NY_PERIODS.includes(period)) {
    // NYS-50-T-NYS p. 23 prints a "Conversion of Tables" procedure for
    // quarterly and 10-day payrolls, which converts to a printed period and
    // scales the RESULT. It is deliberately not implemented: it is an
    // employer's election with its own rounding, and silently applying it would
    // make the engine's output disagree with the state's own instructions
    // without saying so.
    refuseUnprintedPeriod(NY_WITHHOLDING, periodsPerYear);
  }
  return period as NyPeriod;
}

/**
 * IT-2104 offers three filing statuses; the publications print two schedules.
 *
 * "Married, but withhold at higher single rate" is mapped to the SINGLE
 * schedule. That mapping is NOT printed anywhere in NYS-50-T-NYS, IT-2104 or
 * IT-2104-I — the checkbox's own name and the instruction telling married
 * couples under $107,650 to check it in order to withhold more both point at
 * it, but the state does not say so in terms. Recorded here as an inference
 * rather than a citation so that it can be checked against a source rather than
 * re-derived from memory.
 */
function maritalFor(status: string | null): NyMarital {
  return status === "married" ? "married" : "single";
}

/** Table A / B+C: the exemption and deduction allowance for the period. */
function allowanceAmount(
  tables: NyAllowanceTables,
  period: NyPeriod,
  marital: NyMarital,
  exemptions: number,
): bigint {
  const combined = tables.combined[period][marital];
  if (exemptions < combined.length) return U(combined[Math.max(exemptions, 0)]!);
  // "If there are more than 10 exemptions, multiply the number by the exemption
  // amount in table C and add it to the deduction amount from table B."
  return U(tables.deduction[period][marital]) + U(tables.exemption[period]) * BigInt(exemptions);
}

/** Find the Method II line. Half-open: at least column 1, less than column 2. */
function rowFor(table: readonly NyRow[], net: bigint): NyRow | null {
  for (const row of table) {
    if (net < U(row.atLeast)) continue;
    if (row.butLessThan == null || net < U(row.butLessThan)) return row;
  }
  return null;
}

/** Steps 3–5: (net − column 3) × column 4 + column 5, rounded at step 4. */
function applyRow(row: NyRow, net: bigint): bigint {
  return mulRateCents(net - U(row.subtract), row.rate) + U(row.add);
}

// ---------------------------------------------------------------------------
// New York State
// ---------------------------------------------------------------------------

/**
 * The NYS withholding before the Yonkers surcharge is taken of it. Exported
 * because the Yonkers resident levy is 16.75% OF THIS NUMBER, and recomputing
 * it inside the Yonkers engine would be a second copy of New York's schedules.
 */
export function nysWithholding(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
  marital: NyMarital;
  exemptions: number;
}): { tax: bigint; factors: Record<string, string> } {
  const rates = nyRatesForPayDate(input.payDate);
  const period = nyPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {};

  const allowance = allowanceAmount(
    rates.nys.allowances, period, input.marital, input.exemptions,
  );
  factors.NYS_ALLOWANCE = D(allowance);

  // Step 1 — net wages. Floored at zero: an allowance larger than the wages
  // withholds nothing, and a negative net would run backwards through step 3.
  const net = max0(U(input.wages) - allowance);
  factors.NYS_NET = D(net);

  // Method III trigger: annualized net wages at or above the threshold, or at
  // the selected period table's printed rounded terminal handoff.
  const annualizedNet = net * BigInt(input.periodsPerYear);
  factors.NYS_ANNUALIZED_NET = D(annualizedNet);
  const threshold = U(rates.nys.methodIIIThreshold[input.marital]);
  const table = rates.nys.tables[period][input.marital];
  const terminalMethodII = table[table.length - 1]!;
  const printedMethodIIIBoundary = terminalMethodII.butLessThan == null
    ? null
    : U(terminalMethodII.butLessThan);

  // The publications' per-period tables hand off at a rounded whole-dollar
  // boundary (for example, "$20,722 & over" on the weekly single table),
  // while the Method III note states the equivalent exact annualized threshold.
  // When those representations differ by a fraction of a dollar, the printed
  // terminal handoff is authoritative: routing at it prevents a gap between
  // the last Method II line and Method III. The annualized comparison remains
  // necessary for tables whose rounded boundary is above the exact threshold.
  if (
    annualizedNet >= threshold
    || (printedMethodIIIBoundary != null && net >= printedMethodIIIBoundary)
  ) {
    // Method III applies the flat rate to the WHOLE annualized wage, not to an
    // excess over the band floor. NYS-50-T-NYS (1/26) p. 22.
    const bands = rates.nys.methodIII[input.marital];
    let band = bands[0]!;
    for (const candidate of bands) if (annualizedNet >= U(candidate.atLeast)) band = candidate;
    const annualTax = mulRateCents(annualizedNet, band.rate);
    const tax = divIntCents(annualTax, input.periodsPerYear);
    factors.NYS_METHOD = "3";
    factors.NYS_METHOD3_RATE = band.rate;
    factors.NYS_TAX = D(tax);
    return { tax, factors };
  }

  factors.NYS_METHOD = "2";
  const row = rowFor(table, net);
  if (!row) {
    // Unreachable while the tables cover [0, methodIIIThreshold/P) with no
    // holes, which the conformance test proves. Refusing rather than defaulting
    // to zero keeps a future transcription gap loud.
    throw new Error(
      `no New York State Method II line covers net wages of ${D(net)} for a `
      + `${input.marital} ${period} payroll — engine/src/payroll/us/states/ny.ts`,
    );
  }
  const tax = applyRow(row, net);
  factors.NYS_TAX = D(tax);
  return { tax, factors };
}

function computeNys(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = nyRatesForPayDate(input.payDate);
  const marital = maritalFor(certificateChoice(input.certificate, "filing_status"));
  const exemptions = certificateCount(input.certificate, "nys_allowances") ?? 0;
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  const { tax, factors } = nysWithholding({
    payDate: input.payDate,
    periodsPerYear: input.periodsPerYear,
    wages: D(wages),
    marital,
    exemptions,
  });

  const extra = U(certificateAmount(input.certificate, "nys_additional") ?? "0");
  return {
    state: "NY",
    year: rates.year,
    tax: D(tax + extra),
    // Supplemental wages paid together with regular wages in one period are
    // withheld "as if the total were a single payment for a regular payroll
    // period" — which is what the aggregation above does. The separate-payment
    // flat-rate election needs facts about payment timing this engine is not
    // given.
    taxSupplemental: D(0n),
    factors,
  };
}

export const NY_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NY",
  label: "New York State income tax",
  certificateKey: "us_ny_it2104",
  ratesModule: RATES_MODULE,
  editions: NY_TAX_YEAR_EDITIONS,
  printedPeriods: NY_PERIODS,
  compute: computeNys,
};

// ---------------------------------------------------------------------------
// New York City — RESIDENTS ONLY
// ---------------------------------------------------------------------------

/**
 * New York City's resident income tax.
 *
 * It reaches RESIDENTS ONLY: "Nonresidents of New York City are not liable for
 * New York City personal income tax" (tax.ny.gov nonresident FAQs), and "All
 * wages paid to a New York City resident are also subject to New York City
 * income tax withholding EVEN THOUGH THE SERVICES MAY HAVE BEEN PERFORMED
 * OUTSIDE NEW YORK CITY" (NYS-50 (12/23) part G). Both halves matter: a
 * commuter into Manhattan owes nothing, and a city resident working in New
 * Jersey owes it all. The reach is declared on the levy, and the resolver
 * applies it — this engine is called only when the levy resolved.
 *
 * The city's allowance count is its OWN number: IT-2104 line 2, distinct from
 * the line 1 count that serves the state and Yonkers.
 */
function computeNyc(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = nyRatesForPayDate(input.payDate);
  const period = nyPeriodFor(input.periodsPerYear);
  const marital = maritalFor(certificateChoice(input.certificate, "filing_status"));
  const exemptions = certificateCount(input.certificate, "nyc_allowances") ?? 0;
  const factors: Record<string, string> = {};

  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const allowance = allowanceAmount(rates.nyc.allowances, period, marital, exemptions);
  factors.NYC_ALLOWANCE = D(allowance);
  const net = max0(wages - allowance);
  factors.NYC_NET = D(net);

  const row = rowFor(rates.nyc.tables[period], net);
  if (!row) {
    throw new Error(
      `no New York City Method II line covers net wages of ${D(net)} for a ${period} payroll `
      + "— engine/src/payroll/us/states/ny.ts",
    );
  }
  const tax = applyRow(row, net);
  factors.NYC_TAX = D(tax);
  const extra = U(certificateAmount(input.certificate, "nyc_additional") ?? "0");

  return {
    state: "NY-NYC",
    year: rates.year,
    tax: D(tax + extra),
    taxSupplemental: D(0n),
    factors,
  };
}

export const NYC_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NY-NYC",
  label: "New York City resident income tax",
  certificateKey: "us_ny_it2104",
  ratesModule: RATES_MODULE,
  editions: NY_TAX_YEAR_EDITIONS,
  printedPeriods: NY_PERIODS,
  compute: computeNyc,
};

// ---------------------------------------------------------------------------
// Yonkers — a resident SURCHARGE and a nonresident EARNINGS TAX
// ---------------------------------------------------------------------------

/**
 * Yonkers levies two different taxes on two different populations, computed
 * from two different bases, and a system that models "the Yonkers rate" as one
 * number is wrong for one of them:
 *
 *   RESIDENT     16.75% of the New York State withholding — a surcharge on a
 *                TAX, reaching all wages "even if the services are performed
 *                outside Yonkers".
 *   NONRESIDENT  0.50% of Yonkers-SOURCE GROSS WAGES after a banded exclusion,
 *                with no withholding at all below the bottom band and a
 *                $3,000-a-year de minimis.
 *
 * The resident branch needs `regionTax`, which the resolution order guarantees
 * by computing the region before its sub-regions.
 */
function computeYonkers(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = nyRatesForPayDate(input.payDate);
  const period = nyPeriodFor(input.periodsPerYear);
  const factors: Record<string, string> = {};
  const wages = U(input.wages) + U(input.supplemental ?? "0");
  const extra = U(certificateAmount(input.certificate, "yonkers_additional") ?? "0");

  if (input.basis === "resident") {
    if (input.regionTax == null) {
      throw new Error(
        "the Yonkers resident tax is a surcharge of 16.75% of the New York State withholding "
        + "(NYS-50-T-Y (1/26), Method II step 5), so the state tax must be computed first and "
        + "passed in. Nothing here recomputes New York's schedules.",
      );
    }
    const surcharge = mulRateCents(U(input.regionTax), rates.yonkers.residentSurcharge);
    factors.YONKERS_BASE = input.regionTax;
    factors.YONKERS_TAX = D(surcharge);
    return {
      state: "NY-YONKERS", year: rates.year,
      tax: D(surcharge + extra), taxSupplemental: D(0n), factors,
    };
  }

  // Method VII — the exact calculation method for the nonresident earnings tax.
  // The base is GROSS wages; Table A allowances play no part.
  const bands = rates.yonkers.nonresidentBands[period];
  const band = bands.find((candidate) =>
    wages >= U(candidate.atLeast)
    && (candidate.butLessThan == null || wages < U(candidate.butLessThan)));
  if (!band || band.exclusion == null) {
    // Line 1 of every Method VII table is "No tax withheld".
    factors.YONKERS_TAX = D(0n);
    return {
      state: "NY-YONKERS", year: rates.year,
      tax: D(extra), taxSupplemental: D(0n), factors,
    };
  }
  factors.YONKERS_EXCLUSION = band.exclusion;
  const taxable = max0(wages - U(band.exclusion));
  const tax = mulRateCents(taxable, rates.yonkers.nonresidentRate);
  factors.YONKERS_TAX = D(tax);
  return {
    state: "NY-YONKERS", year: rates.year,
    tax: D(tax + extra), taxSupplemental: D(0n), factors,
  };
}

export const YONKERS_WITHHOLDING: UsStateWithholdingEngine = {
  state: "NY-YONKERS",
  label: "Yonkers income tax",
  certificateKey: "us_ny_it2104",
  ratesModule: RATES_MODULE,
  editions: NY_TAX_YEAR_EDITIONS,
  printedPeriods: NY_PERIODS,
  compute: computeYonkers,
};

/**
 * Method VIII — the annualized method for the Yonkers nonresident earnings tax.
 *
 * Exported for the conformance goldens, which prove that Methods VII and VIII
 * agree to the cent on the publication's own examples. Not wired in: the state
 * offers it as an alternative "recommended when the pay is steady", and an
 * engine that switched between two published methods on its own would make its
 * output unreproducible.
 */
export function yonkersNonresidentAnnualized(input: {
  payDate: string;
  periodsPerYear: number;
  wages: string;
}): string {
  const rates = nyRatesForPayDate(input.payDate);
  const annualized = U(input.wages) * BigInt(input.periodsPerYear);
  const bands = rates.yonkers.nonresidentBands.annual;
  const band = bands.find((candidate) =>
    annualized > U(candidate.atLeast)
    && (candidate.butLessThan == null || annualized <= U(candidate.butLessThan)));
  if (!band || band.exclusion == null) return D(0n);
  const annualTax = mulRateCents(max0(annualized - U(band.exclusion)), rates.yonkers.nonresidentRate);
  return D(divIntCents(annualTax, input.periodsPerYear));
}
