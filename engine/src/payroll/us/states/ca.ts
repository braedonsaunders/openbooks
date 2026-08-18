/**
 * California Personal Income Tax withholding — METHOD B, EXACT CALCULATION.
 *
 * Sources (fetched from edd.ca.gov, not memory):
 *   "California Withholding Schedules for 2026 — Method B (Exact Calculation
 *     Method)", edd.ca.gov/siteassets/files/pdf_pub_ctr/26methb.pdf, printed
 *     "2026 Withholding Schedules - Method B (INTERNET)". Tables 1–4 (pp. 5–6),
 *     Tables 5–28 (pp. 7–10), Examples A–F (pp. 2–4).
 *   California Employer's Guide (DE 44), Rev. 52 (4-26) — the same schedules
 *     and examples, and the supplemental-wage rates (guide p. 18).
 *   Form DE 4, Rev. 56 (1-26) — the certificate's own fields, and the annual
 *     rate schedules reprinted for Worksheet C.
 *
 * The three renderings were cross-checked against each other and agree
 * figure-for-figure.
 *
 * ---------------------------------------------------------------------------
 * The method, as printed (26methb.pdf p. 2)
 * ---------------------------------------------------------------------------
 *   Step 1  If gross wages ≤ Table 1 (Low Income Exemption), withhold nothing.
 *   Step 2  Subtract Table 2 (Estimated Deduction) for the additional
 *           allowances claimed on DE 4 line 1b.
 *   Step 3  Subtract Table 3 (Standard Deduction) → taxable income.
 *   Step 4  Look the taxable income up in the Table 5–28 entry for the pay
 *           period and filing schedule: tax = rate × (taxable − base) + plus.
 *   Step 5  Subtract Table 4 (Exemption Allowance) — a TAX CREDIT, not a wage
 *           allowance — for the REGULAR allowances only (line 1a).
 *
 * ---------------------------------------------------------------------------
 * Three details that are easy to get wrong, and the golden that catches each
 * ---------------------------------------------------------------------------
 * 1. Table 4 is a CREDIT AGAINST TAX, subtracted after the rate is applied.
 *    Treating it as a wage allowance under-withholds by roughly the marginal
 *    rate times the allowance. Every example catches this.
 *
 * 2. Estimated-deduction allowances (DE 4 line 1b) reduce WAGES via Table 2 and
 *    must NOT be counted again in the Table 4 credit — the publication prints
 *    this as a footnote to Step 5. Example B is the golden: three allowances
 *    claimed, one of them an estimated-deduction allowance, so Table 2 is read
 *    at n=1 and Table 4 at n=2. A system that read Table 4 at n=3 would give
 *    $0.00 instead of $2.38.
 *
 * 3. California prints TWENTY-FOUR rate tables and NONE of them is a scaled
 *    copy of another. Table 14 (semi-annual single) matches Table 12 (quarterly
 *    married) for seven rows and then diverges; Tables 24 and 26 agree through
 *    row 7 and then diverge. Every table is transcribed literally. Deriving one
 *    from another would be right most of the time, which is the worst possible
 *    property for a tax table.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import {
  certificateAmount, certificateChoice, certificateCount, certificateFlag,
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

const RATES_MODULE = "engine/src/payroll/us/states/ca.ts";

/**
 * The four columns Tables 1 and 3 print, headed exactly:
 *   "Single, Dual Income Married or Married with Multiple Employers"
 *   "Married - (Allowances on DE 4 or Form W-4) '0' or '1'"
 *   "Married - (Allowances on DE 4 or Form W-4) '2' or more"
 *   "Unmarried Head of Household"
 *
 * Columns A and B print identical figures at every period, as do C and D. They
 * are kept as four keys rather than collapsed to two, because the EDD prints
 * four and a future year in which they diverge must be a data change, not a
 * code change. `CA_COLUMN_PAIRS_AGREE` in the conformance test asserts the
 * present agreement so the collapse is never re-introduced by hand.
 */
type CaColumn = "single_dual" | "married_0_1" | "married_2_plus" | "head_household";

/** The three tax-rate schedules Tables 5–28 print. */
type CaSchedule = "single" | "married" | "head_household";

/** DE 4 filing status, as the form's own three checkboxes read. */
type CaFilingStatus = "single_or_dual" | "married_one_income" | "head_household";

type ByPeriod<T> = Readonly<Record<UsStatePayPeriod, T>>;

/** One row: tax = rate × (taxable − base) + plus, for taxable ≤ notOver. */
interface CaRateRow {
  /** "If the taxable income is over". */
  over: string;
  /** "But the taxable income is not over". null on the top row. */
  notOver: string | null;
  /** "The computed tax is", as a decimal (1.100% → "0.011"). */
  rate: string;
  /** "Of the amount over". */
  base: string;
  /** "Plus" — the accumulated tax of every lower bracket. */
  plus: string;
}

export interface CaYearRates {
  year: number;
  status: "published" | "draft";
  /** Table 1 — Low Income Exemption. */
  lowIncomeExemption: ByPeriod<Readonly<Record<CaColumn, string>>>;
  /** Table 2 — Estimated Deduction, indexed by allowance count 1…10. */
  estimatedDeduction: ByPeriod<readonly string[]>;
  /** Table 3 — Standard Deduction. */
  standardDeduction: ByPeriod<Readonly<Record<CaColumn, string>>>;
  /** Table 4 — Exemption Allowance credit, indexed by allowance count 0…10. */
  exemptionAllowance: ByPeriod<readonly string[]>;
  /** Tables 5–28. */
  rateTables: ByPeriod<Readonly<Record<CaSchedule, readonly CaRateRow[]>>>;
  /** DE 44 p. 18 — the flat rates for supplemental wages paid separately. */
  supplemental: { bonusesAndStockOptions: string; other: string };
}

// ---------------------------------------------------------------------------
// Table 1 — Low Income Exemption (26methb.pdf p. 5)
// ---------------------------------------------------------------------------
const LOW_INCOME_2026: ByPeriod<Readonly<Record<CaColumn, string>>> = {
  weekly: { single_dual: "363", married_0_1: "363", married_2_plus: "727", head_household: "727" },
  biweekly: { single_dual: "727", married_0_1: "727", married_2_plus: "1454", head_household: "1454" },
  semimonthly: { single_dual: "787", married_0_1: "787", married_2_plus: "1575", head_household: "1575" },
  monthly: { single_dual: "1575", married_0_1: "1575", married_2_plus: "3149", head_household: "3149" },
  quarterly: { single_dual: "4724", married_0_1: "4724", married_2_plus: "9448", head_household: "9448" },
  semiannual: { single_dual: "9448", married_0_1: "9448", married_2_plus: "18896", head_household: "18896" },
  annual: { single_dual: "18896", married_0_1: "18896", married_2_plus: "37791", head_household: "37791" },
  daily: { single_dual: "73", married_0_1: "73", married_2_plus: "145", head_household: "145" },
};

// ---------------------------------------------------------------------------
// Table 2 — Estimated Deduction (26methb.pdf p. 5)
// Index 0 is unused (the table starts at one allowance); index n is n allowances.
// ---------------------------------------------------------------------------
const ESTIMATED_DEDUCTION_2026: ByPeriod<readonly string[]> = {
  weekly: ["0", "19", "38", "58", "77", "96", "115", "135", "154", "173", "192"],
  biweekly: ["0", "38", "77", "115", "154", "192", "231", "269", "308", "346", "385"],
  semimonthly: ["0", "42", "83", "125", "167", "208", "250", "292", "333", "375", "417"],
  monthly: ["0", "83", "167", "250", "333", "417", "500", "583", "667", "750", "833"],
  quarterly: ["0", "250", "500", "750", "1000", "1250", "1500", "1750", "2000", "2250", "2500"],
  semiannual: ["0", "500", "1000", "1500", "2000", "2500", "3000", "3500", "4000", "4500", "5000"],
  annual: ["0", "1000", "2000", "3000", "4000", "5000", "6000", "7000", "8000", "9000", "10000"],
  daily: ["0", "4", "8", "12", "15", "19", "23", "27", "31", "35", "38"],
};

// ---------------------------------------------------------------------------
// Table 3 — Standard Deduction (26methb.pdf p. 6)
// ---------------------------------------------------------------------------
const STANDARD_DEDUCTION_2026: ByPeriod<Readonly<Record<CaColumn, string>>> = {
  weekly: { single_dual: "110", married_0_1: "110", married_2_plus: "219", head_household: "219" },
  biweekly: { single_dual: "219", married_0_1: "219", married_2_plus: "439", head_household: "439" },
  semimonthly: { single_dual: "238", married_0_1: "238", married_2_plus: "476", head_household: "476" },
  monthly: { single_dual: "476", married_0_1: "476", married_2_plus: "951", head_household: "951" },
  quarterly: { single_dual: "1427", married_0_1: "1427", married_2_plus: "2853", head_household: "2853" },
  semiannual: { single_dual: "2853", married_0_1: "2853", married_2_plus: "5706", head_household: "5706" },
  annual: { single_dual: "5706", married_0_1: "5706", married_2_plus: "11412", head_household: "11412" },
  daily: { single_dual: "22", married_0_1: "22", married_2_plus: "44", head_household: "44" },
};

// ---------------------------------------------------------------------------
// Table 4 — Exemption Allowance, a CREDIT against tax (26methb.pdf p. 6)
// Index n is n allowances, 0…10.
// ---------------------------------------------------------------------------
const EXEMPTION_ALLOWANCE_2026: ByPeriod<readonly string[]> = {
  weekly: ["0.00", "3.24", "6.47", "9.71", "12.95", "16.18", "19.42", "22.66", "25.89", "29.13", "32.37"],
  biweekly: ["0.00", "6.47", "12.95", "19.42", "25.89", "32.37", "38.84", "45.31", "51.78", "58.26", "64.73"],
  semimonthly: ["0.00", "7.01", "14.03", "21.04", "28.05", "35.06", "42.08", "49.09", "56.10", "63.11", "70.13"],
  monthly: ["0.00", "14.03", "28.05", "42.08", "56.10", "70.13", "84.15", "98.18", "112.20", "126.23", "140.25"],
  quarterly: ["0.00", "42.08", "84.15", "126.23", "168.30", "210.38", "252.45", "294.53", "336.60", "378.68", "420.75"],
  semiannual: ["0.00", "84.15", "168.30", "252.45", "336.60", "420.75", "504.90", "589.05", "673.20", "757.35", "841.50"],
  annual: ["0.00", "168.30", "336.60", "504.90", "673.20", "841.50", "1009.80", "1178.10", "1346.40", "1514.70", "1683.00"],
  daily: ["0.00", "0.65", "1.29", "1.94", "2.59", "3.24", "3.88", "4.53", "5.18", "5.83", "6.47"],
};

// ---------------------------------------------------------------------------
// Tables 5–28 — Tax Rate Tables (26methb.pdf pp. 7–10)
//
// The ten marginal rates are identical in all twenty-four tables; only the
// breakpoints and the accumulated "plus" amounts change.
// ---------------------------------------------------------------------------
const R = {
  a: "0.011", b: "0.022", c: "0.044", d: "0.066", e: "0.088",
  f: "0.1023", g: "0.1133", h: "0.1243", i: "0.1353", j: "0.1463",
} as const;

/** Build the ten rows from the printed breakpoints and accumulated amounts. */
function rows(
  cuts: readonly [string, string, string, string, string, string, string, string, string],
  plus: readonly [string, string, string, string, string, string, string, string, string],
): readonly CaRateRow[] {
  const rates = [R.a, R.b, R.c, R.d, R.e, R.f, R.g, R.h, R.i, R.j];
  const overs = ["0", ...cuts];
  const pluses = ["0.00", ...plus];
  return overs.map((over, index) => ({
    over,
    notOver: index + 1 < overs.length ? overs[index + 1]! : null,
    rate: rates[index]!,
    base: over,
    plus: pluses[index]!,
  }));
}

// Table 5 — Annual, Single / Dual Income Married / Married with Multiple Employers
const T5 = rows(
  ["11079", "26264", "41452", "57542", "72724", "371479", "445771", "742953", "1000000"],
  ["121.87", "455.94", "1124.21", "2186.15", "3522.17", "34084.81", "42502.09", "79441.81", "114220.27"],
);
// Table 6 — Annual, Married
const T6 = rows(
  ["22158", "52528", "82904", "115084", "145448", "742958", "891542", "1000000", "1485906"],
  ["243.74", "911.88", "2248.42", "4372.30", "7044.33", "68169.60", "85004.17", "98485.50", "164228.58"],
);
// Table 7 — Annual, Unmarried Head of Household
const T7 = rows(
  ["22173", "52530", "67716", "83805", "98990", "505208", "606251", "1000000", "1010417"],
  ["243.90", "911.75", "1579.93", "2641.80", "3978.08", "45534.18", "56982.35", "105925.35", "107334.77"],
);
// Table 8 — Daily / Miscellaneous, Single / Dual / Multiple
const T8 = rows(
  ["43", "101", "159", "221", "280", "1429", "1715", "2858", "3846"],
  ["0.47", "1.75", "4.30", "8.39", "13.58", "131.12", "163.52", "305.59", "439.27"],
);
// Table 9 — Daily / Miscellaneous, Married
const T9 = rows(
  ["86", "202", "318", "442", "560", "2858", "3430", "3846", "5715"],
  ["0.95", "3.50", "8.60", "16.78", "27.16", "262.25", "327.06", "378.77", "631.65"],
);
// Table 10 — Daily / Miscellaneous, Unmarried Head of Household
const T10 = rows(
  ["85", "202", "260", "322", "381", "1943", "2332", "3846", "3886"],
  ["0.94", "3.51", "6.06", "10.15", "15.34", "175.13", "219.20", "407.39", "412.80"],
);
// Table 11 — Quarterly, Single / Dual / Multiple
const T11 = rows(
  ["2770", "6566", "10363", "14386", "18181", "92870", "111443", "185738", "250000"],
  ["30.47", "113.98", "281.05", "546.57", "880.53", "8521.21", "10625.53", "19860.40", "28555.05"],
);
// Table 12 — Quarterly, Married
const T12 = rows(
  ["5540", "13132", "20726", "28772", "36362", "185740", "222886", "250000", "371477"],
  ["60.94", "227.96", "562.10", "1093.14", "1761.06", "17042.43", "21251.07", "24621.34", "41057.18"],
);
// Table 13 — Quarterly, Unmarried Head of Household
const T13 = rows(
  ["5543", "13133", "16929", "20951", "24748", "126302", "151563", "250000", "252604"],
  ["60.97", "227.95", "394.97", "660.42", "994.56", "11383.53", "14245.60", "26481.32", "26833.64"],
);
// Table 14 — Semi-annual, Single / Dual / Multiple
const T14 = rows(
  ["5540", "13132", "20726", "28772", "36362", "185740", "222886", "371476", "500000"],
  ["60.94", "227.96", "562.10", "1093.14", "1761.06", "17042.43", "21251.07", "39720.81", "57110.11"],
);
// Table 15 — Semi-annual, Married
const T15 = rows(
  ["11080", "26264", "41452", "57544", "72724", "371480", "445772", "500000", "742954"],
  ["121.88", "455.93", "1124.20", "2186.27", "3522.11", "34084.85", "42502.13", "49242.67", "82114.35"],
);
// Table 16 — Semi-annual, Unmarried Head of Household
const T16 = rows(
  ["11086", "26266", "33858", "41902", "49496", "252604", "303126", "500000", "505208"],
  ["121.95", "455.91", "789.96", "1320.86", "1989.13", "22767.08", "28491.22", "52962.66", "53667.30"],
);
// Table 17 — Semi-monthly, Single / Dual / Multiple
const T17 = rows(
  ["462", "1094", "1727", "2398", "3030", "15478", "18574", "30956", "41667"],
  ["5.08", "18.98", "46.83", "91.12", "146.74", "1420.17", "1770.95", "3310.03", "4759.23"],
);
// Table 18 — Semi-monthly, Married
const T18 = rows(
  ["924", "2188", "3454", "4796", "6060", "30956", "37148", "41667", "61913"],
  ["10.16", "37.97", "93.67", "182.24", "293.47", "2840.33", "3541.88", "4103.59", "6842.87"],
);
// Table 19 — Semi-monthly, Unmarried Head of Household
const T19 = rows(
  ["924", "2189", "2822", "3492", "4125", "21050", "25260", "41667", "42101"],
  ["10.16", "37.99", "65.84", "110.06", "165.76", "1897.19", "2374.18", "4413.57", "4472.29"],
);
// Table 20 — Monthly, Single / Dual / Multiple
const T20 = rows(
  ["924", "2188", "3454", "4796", "6060", "30956", "37148", "61912", "83334"],
  ["10.16", "37.97", "93.67", "182.24", "293.47", "2840.33", "3541.88", "6620.05", "9518.45"],
);
// Table 21 — Monthly, Married
const T21 = rows(
  ["1848", "4376", "6908", "9592", "12120", "61912", "74296", "83334", "123826"],
  ["20.33", "75.95", "187.36", "364.50", "586.96", "5680.68", "7083.79", "8207.21", "13685.78"],
);
// Table 22 — Monthly, Unmarried Head of Household
const T22 = rows(
  ["1848", "4378", "5644", "6984", "8250", "42100", "50520", "83334", "84202"],
  ["20.33", "75.99", "131.69", "220.13", "331.54", "3794.40", "4748.39", "8827.17", "8944.61"],
);
// Table 23 — Weekly, Single / Dual / Multiple
const T23 = rows(
  ["213", "505", "797", "1107", "1399", "7144", "8573", "14288", "19231"],
  ["2.34", "8.76", "21.61", "42.07", "67.77", "655.48", "817.39", "1527.76", "2196.55"],
);
// Table 24 — Weekly, Married
const T24 = rows(
  ["426", "1010", "1594", "2214", "2798", "14288", "17146", "19231", "28575"],
  ["4.69", "17.54", "43.24", "84.16", "135.55", "1310.98", "1634.79", "1893.96", "3158.20"],
);
// Table 25 — Weekly, Unmarried Head of Household
const T25 = rows(
  ["426", "1010", "1302", "1612", "1904", "9716", "11659", "19231", "19431"],
  ["4.69", "17.54", "30.39", "50.85", "76.55", "875.72", "1095.86", "2037.06", "2064.12"],
);
// Table 26 — Bi-weekly, Single / Dual / Multiple
const T26 = rows(
  ["426", "1010", "1594", "2214", "2798", "14288", "17146", "28576", "38462"],
  ["4.69", "17.54", "43.24", "84.16", "135.55", "1310.98", "1634.79", "3055.54", "4393.12"],
);
// Table 27 — Bi-weekly, Married
const T27 = rows(
  ["852", "2020", "3188", "4428", "5596", "28576", "34292", "38462", "57150"],
  ["9.37", "35.07", "86.46", "168.30", "271.08", "2621.93", "3269.55", "3787.88", "6316.37"],
);
// Table 28 — Bi-weekly, Unmarried Head of Household
const T28 = rows(
  ["852", "2020", "2604", "3224", "3808", "19432", "23318", "38462", "38862"],
  ["9.37", "35.07", "60.77", "101.69", "153.08", "1751.42", "2191.70", "4074.10", "4128.22"],
);

const RATE_TABLES_2026: ByPeriod<Readonly<Record<CaSchedule, readonly CaRateRow[]>>> = {
  annual: { single: T5, married: T6, head_household: T7 },
  daily: { single: T8, married: T9, head_household: T10 },
  quarterly: { single: T11, married: T12, head_household: T13 },
  semiannual: { single: T14, married: T15, head_household: T16 },
  semimonthly: { single: T17, married: T18, head_household: T19 },
  monthly: { single: T20, married: T21, head_household: T22 },
  weekly: { single: T23, married: T24, head_household: T25 },
  biweekly: { single: T26, married: T27, head_household: T28 },
};

export const CA_RATES_2026: CaYearRates = {
  year: 2026,
  status: "published",
  lowIncomeExemption: LOW_INCOME_2026,
  estimatedDeduction: ESTIMATED_DEDUCTION_2026,
  standardDeduction: STANDARD_DEDUCTION_2026,
  exemptionAllowance: EXEMPTION_ALLOWANCE_2026,
  rateTables: RATE_TABLES_2026,
  // DE 44 p. 18. Applicable only when the supplemental payment is NOT made at
  // the same time as regular wages; when it is, the guide REQUIRES aggregation
  // through the schedules above.
  supplemental: { bonusesAndStockOptions: "0.1023", other: "0.066" },
};

const CA_EDITIONS_BY_YEAR: Record<number, CaYearRates> = {
  [CA_RATES_2026.year]: CA_RATES_2026,
};

export const CA_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "California Withholding Schedules for 2026 — Method B",
  effectiveFrom: "2026-01-01",
  citation:
    "California EDD, California Withholding Schedules for 2026, Method B (Exact Calculation "
    + "Method), Tables 1–4 and 5–28; California Employer's Guide DE 44 Rev. 52 (4-26)",
  status: "published",
  region: "CA",
}];

export function caRatesForPayDate(payDate: string): CaYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = CA_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(CA_WITHHOLDING, year);
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Column and schedule selection
// ---------------------------------------------------------------------------

/**
 * Which Table 1 / Table 3 column applies.
 *
 * The married split turns on the ALLOWANCE COUNT, which is the one point the
 * publication leaves genuinely ambiguous: the column headers say only
 * "Allowances on DE 4 or Form W-4", and DE 4 collects a regular count (1a), an
 * estimated-deduction count (1b) and their total (1c). Example B — married,
 * three allowances of which one is for estimated deductions — uses the
 * "'2' or more" column, which is consistent with EITHER reading, so the
 * examples do not settle it.
 *
 * This engine reads the TOTAL (1a + 1b). Two reasons, both on the record so the
 * choice can be revisited against a source rather than re-litigated from
 * memory: the headers place no qualifier on "allowances", and the publication
 * DOES place an explicit qualifier where it means regular-only (the Step 5
 * footnote: "such allowances must not be used in the determination of tax
 * credits"). A rule stated for one table and not the other is most likely not
 * meant for the other. The reading matters only for a married employee whose
 * regular count is 1 and whose total is 2 or more.
 */
function columnFor(status: CaFilingStatus, totalAllowances: number): CaColumn {
  switch (status) {
    case "single_or_dual": return "single_dual";
    case "head_household": return "head_household";
    case "married_one_income":
      return totalAllowances >= 2 ? "married_2_plus" : "married_0_1";
  }
}

/** Which Table 5–28 schedule applies. Keyed on filing status alone. */
function scheduleFor(status: CaFilingStatus): CaSchedule {
  switch (status) {
    case "single_or_dual": return "single";
    case "married_one_income": return "married";
    case "head_household": return "head_household";
  }
}

function rowFor(table: readonly CaRateRow[], taxable: bigint): CaRateRow {
  for (const row of table) {
    if (row.notOver == null) return row;
    if (taxable <= U(row.notOver)) return row;
  }
  return table[table.length - 1]!;
}

/**
 * Read an indexed table, applying the publication's own over-the-top rule:
 * "if the number of allowances claimed exceeds 10, multiply the amount for ONE
 * allowance by the total number of allowances" (footnotes to Tables 2 and 4).
 * The worked footnote — 15 allowances weekly giving $48.60 — confirms the
 * multiplier is the one-allowance figure and not a tenth of the ten-allowance
 * figure, which differ because the printed table is rounded per row.
 */
function indexed(table: readonly string[], count: number): bigint {
  if (count <= 0) return 0n;
  if (count < table.length) return U(table[count]!);
  return U(table[1]!) * BigInt(count);
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = caRatesForPayDate(input.payDate);
  const period = payPeriodFor(input.periodsPerYear);
  if (period == null) refuseUnprintedPeriod(CA_WITHHOLDING, input.periodsPerYear);

  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  // DE 4: an employee who has filed no certificate is withheld at "Single with
  // Zero withholding allowance" — a statutory default, declared on the
  // certificate's own fields, not assumed here.
  const status = (certificateChoice(input.certificate, "filing_status")
    ?? "single_or_dual") as CaFilingStatus;
  const regular = certificateCount(input.certificate, "regular_allowances") ?? 0;
  const estimated = certificateCount(input.certificate, "estimated_deduction_allowances") ?? 0;
  const total = regular + estimated;

  if (certificateFlag(input.certificate, "exempt")
    || certificateFlag(input.certificate, "military_spouse_exempt")) {
    trace("CA_EXEMPT", 1n);
    return { state: "CA", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  const column = columnFor(status, total);
  const schedule = scheduleFor(status);

  const wages = U(input.wages);
  const supplemental = U(input.supplemental ?? "0");

  // DE 44 p. 18: a supplemental payment made AT THE SAME TIME as regular wages
  // must be aggregated and run through the schedules. This engine is handed one
  // period's amounts together, which is that case, so the two are summed and
  // the flat rates are not used. The separate-payment election is a real
  // alternative the employer may make, and it is deliberately NOT implemented:
  // it depends on facts about payment timing this engine is not given, and
  // guessing which one applies would change withholding silently.
  const gross = wages + supplemental;
  trace("CA_GROSS", gross);

  // Step 1 — Low Income Exemption. "less than, OR EQUAL TO" withholds nothing.
  const lowIncome = U(rates.lowIncomeExemption[period][column]);
  trace("CA_LOW_INCOME", lowIncome);
  if (gross <= lowIncome) {
    trace("CA_TAX", 0n);
    // The DE 4 line 2 extra amount is an employee request and the guide gives no
    // rule suspending it below the exemption; it is withheld either way.
    const onlyExtra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
    return {
      state: "CA", year: rates.year, tax: D(onlyExtra), taxSupplemental: D(0n), factors,
    };
  }

  // Step 2 — Estimated Deduction Table, on the line 1b count only.
  const estimatedDeduction = indexed(rates.estimatedDeduction[period], estimated);
  trace("CA_EST_DEDUCTION", estimatedDeduction);
  const subject = max0(gross - estimatedDeduction);
  trace("CA_SUBJECT", subject);

  // Step 3 — Standard Deduction Table.
  const standard = U(rates.standardDeduction[period][column]);
  trace("CA_STD_DEDUCTION", standard);
  const taxable = max0(subject - standard);
  trace("CA_TAXABLE", taxable);

  // Step 4 — the rate table for this period and schedule.
  const row = rowFor(rates.rateTables[period][schedule], taxable);
  const computed = mulRateCents(taxable - U(row.base), row.rate) + U(row.plus);
  trace("CA_COMPUTED_TAX", computed);

  // Step 5 — the Exemption Allowance CREDIT, on the REGULAR count only.
  const credit = indexed(rates.exemptionAllowance[period], regular);
  trace("CA_CREDIT", credit);
  const net = max0(computed - credit);
  trace("CA_NET", net);

  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const withheld = net + extra;
  trace("CA_TAX", withheld);

  return {
    state: "CA",
    year: rates.year,
    tax: D(withheld),
    taxSupplemental: D(0n),
    factors,
  };
}

/**
 * The annualized variant the guide offers (Examples E and F): compute on the
 * ANNUAL tables and divide by the pay periods. Exported for the conformance
 * goldens, and not wired into `compute` — the guide presents it as an
 * employer's ELECTION to conserve memory, it produces different cents from the
 * per-period method, and an engine that silently switched between two published
 * methods would make its own output unreproducible.
 */
export function caAnnualizedMethod(input: {
  payDate: string;
  periodsPerYear: number;
  wagesPerPeriod: string;
  filingStatus: CaFilingStatus;
  regularAllowances?: number;
  estimatedDeductionAllowances?: number;
}): { annualTax: string; perPeriod: string } {
  const rates = caRatesForPayDate(input.payDate);
  const regular = input.regularAllowances ?? 0;
  const estimated = input.estimatedDeductionAllowances ?? 0;
  const column = columnFor(input.filingStatus, regular + estimated);
  const schedule = scheduleFor(input.filingStatus);

  const annualWages = U(input.wagesPerPeriod) * BigInt(input.periodsPerYear);
  const subject = max0(annualWages - indexed(rates.estimatedDeduction.annual, estimated));
  const taxable = max0(subject - U(rates.standardDeduction.annual[column]));
  const row = rowFor(rates.rateTables.annual[schedule], taxable);
  const computed = mulRateCents(taxable - U(row.base), row.rate) + U(row.plus);
  const annual = max0(computed - indexed(rates.exemptionAllowance.annual, regular));
  return { annualTax: D(annual), perPeriod: D(divIntCents(annual, input.periodsPerYear)) };
}

export const CA_WITHHOLDING: UsStateWithholdingEngine = {
  state: "CA",
  label: "California PIT",
  certificateKey: "us_ca_de4",
  ratesModule: RATES_MODULE,
  editions: CA_TAX_YEAR_EDITIONS,
  printedPeriods: [
    "weekly", "biweekly", "semimonthly", "monthly",
    "quarterly", "semiannual", "annual", "daily",
  ],
  compute,
};
