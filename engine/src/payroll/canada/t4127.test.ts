/**
 * T4127 conformance goldens, 2024–2026.
 *
 * Every row is either a figure the CRA publishes (the Chapter 8 claim-code
 * K1/K1P columns) or a full stub hand-worked through the guide's formulas
 * (retain annual credit precision), independent of the engine code. Rows differ by
 * year and edition; one loop prices them all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../../money/money.ts";
import { payrollCertificate, resolveCertificate, type StoredCertificate } from "../certificates.ts";
import "../packs.ts";
import { unfilledPaths } from "../unfilled.ts";
import { computeCaStatutory } from "./compute-statutory.ts";
import { calculateT4127, periodTaxLegs, type T4127Input, type T4127Result } from "./t4127.ts";
import { D, r2, U } from "../../money/payroll-decimal.ts";
import { RATES_2026_JAN, RATES_2026_JUL, ratesForPayDate, type Province } from "./rates.ts";
import { RATES_2024_JAN } from "./rates-2024.ts";
import { RATES_2025_JAN, RATES_2025_JUL } from "./rates-2025.ts";

type ResultKey = Exclude<keyof T4127Result, "factors">;
interface Golden {
  year: number;
  label: string;
  input: T4127Input;
  /** Result legs; money as 2dp (the engine's 4dp with "00" appended), edition as a number. */
  expected?: Partial<Record<ResultKey, string | number>>;
  /** Trace factors; null asserts the factor is absent. */
  expectedFactors?: Record<string, string | null>;
  citation: string;
  /** Published credit columns display cents; calculation factors retain four places. */
  tabulatedCredits?: boolean;
}

const ED = {
  119: "T4127 119th edition (Jan 2024)",
  120: "T4127 120th edition (Jan 2025)",
  121: "T4127 121st edition (Jul 2025)",
  122: "T4127 122nd edition (Jan 2026)",
  123: "T4127 123rd edition (Jul 2026)",
} as const;
type Edition = keyof typeof ED;

/** Federal claim codes 1–10: K1 = lowest rate × TC, as printed in Table 8.9. */
const federalK1 = (year: number, edition: Edition, payDate: string, k1s: string[]): Golden[] =>
  k1s.map((K1, i) => ({
    year, label: `federal CC${i + 1} K1 (${edition}th ed.)`, citation: `${ED[edition]} Table 8.9`,
    input: { payDate, province: "ON", periodsPerYear: 26, income: "1.00", federalClaimCode: i + 1,
      provincialClaimCode: 0, cppExempt: true, eiExempt: true },
    expectedFactors: { K1 }, tabulatedCredits: true,
  }));

/** Provincial claim-code endpoints: published TCP and K1P per jurisdiction. */
const provincialK1P = (
  year: number, edition: Edition, payDate: string, rows: [Province, number, string, string][],
): Golden[] => rows.map(([province, code, TCP, K1P]) => ({
  year, label: `${province} CC${code} TCP/K1P (${edition}th ed.)`,
  citation: `${ED[edition]} Chapter 8 ${province} claim codes`,
  input: { payDate, province, periodsPerYear: 26, income: "1.00", federalClaimCode: 0,
    provincialClaimCode: code, cppExempt: true, eiExempt: true },
  expectedFactors: { TCP, K1P }, tabulatedCredits: true,
}));

const cc1 = { federalClaimCode: 1, provincialClaimCode: 1 } as const;
const on26 = { province: "ON", periodsPerYear: 26, ...cc1 } as const;
const onSurtax = { payDate: "2026-02-13", province: "ON", periodsPerYear: 26,
  federalClaimCode: 0, provincialClaimCode: 0, cppExempt: true, eiExempt: true } as const;
const nsPhaseOut = (payDate: string, TCP: string, edition: Edition): Golden => ({
  year: Number(payDate.slice(0, 4)), label: `NS BPA income phase-out, no TD1 (${edition}th ed.)`,
  citation: `${ED[edition]} Nova Scotia BPA`,
  input: { payDate, province: "NS", periodsPerYear: 2, income: "25000.00", pensionable: "0",
    insurable: "0", federalClaimCode: 1 },
  expectedFactors: { TCP },
});

const GOLDENS: Golden[] = [
  {year:2026,label:"Option 2 bonuses use the annual tax difference rather than Option 1’s low-income flat withholding",citation:`Chapter 5 bonus steps, ${ED[122]}`,
    input:{payDate:"2026-03-06",province:"ON",periodsPerYear:52,...cc1,income:"0",nonPeriodic:"400",pensionable:"0",insurable:"0",pensionableNonPeriodic:"0",insurableNonPeriodic:"0",qpipNonPeriodic:"0",
      averaging:{elapsedPeriods:1,income:"0",pensionDeductions:"0",alimonyDeductions:"0",unionDues:"0",f5A:"0",pensionablePeriodic:"0",insurablePeriodic:"0",qpipPeriodic:"0",pensionableNonPeriodic:"0",insurableNonPeriodic:"0",qpipNonPeriodic:"0",periodicTax:"0",bonusTax:"0"}},
    expected:{periodicTax:"0.00",bonusTax:"0.00"}},
  {year:2026,label:"a non-pensionable bonus does not consume the periodic enhanced-CPP deduction",citation:`hand-worked, ${ED[122]}`,
    input:{payDate:"2026-03-06",province:"ON",periodsPerYear:52,...cc1,income:"1000",nonPeriodic:"400",pensionable:"1000",pensionableNonPeriodic:"0",insurable:"1000"},
    expected:{cpp:"55.50",f5:"9.33",f5A:"9.33",f5B:"0.00"}},
  // ── Published claim-code columns ─────────────────────────────────────────
  ...federalK1(2024, 119, "2024-01-15", ["2355.75", "2558.63", "2964.38", "3370.13", "3775.88",
    "4181.63", "4587.38", "4993.13", "5398.88", "5804.63"]),
  ...federalK1(2025, 120, "2025-01-15", ["2419.35", "2627.70", "3044.40", "3461.10", "3877.80",
    "4294.50", "4711.20", "5127.90", "5544.60", "5961.30"]),
  // Same TC chart as January, prorated 14% lowest rate for Jul–Dec.
  ...federalK1(2025, 121, "2025-08-14", ["2258.06", "2452.52", "2841.44", "3230.36", "3619.28",
    "4008.20", "4397.12", "4786.04", "5174.96", "5563.88"]),
  ...federalK1(2026, 122, "2026-01-15", ["2303.28", "2501.59", "2898.21", "3294.83", "3691.45",
    "4088.07", "4484.69", "4881.31", "5277.93", "5674.55"]),
  ...provincialK1P(2024, 119, "2024-01-15", [
    ["AB", 1, "21885.00", "2188.50"], ["AB", 10, "48490.00", "4849.00"],
    ["BC", 1, "12580.00", "636.55"], ["BC", 10, "36643.50", "1854.16"],
    ["MB", 1, "15780.00", "1704.24"], ["MB", 10, "30170.50", "3258.41"],
    ["NB", 1, "13044.00", "1226.14"], ["NB", 10, "35739.00", "3359.47"],
    ["NL", 1, "10818.00", "941.17"], ["NL", 10, "30674.00", "2668.64"],
    ["NS", 1, "11481.00", "1009.18"], ["NS", 10, "25081.00", "2204.62"],
    ["NT", 1, "17373.00", "1025.01"], ["NT", 10, "42762.50", "2522.99"],
    ["NU", 1, "18767.00", "750.68"], ["NU", 10, "44564.50", "1782.58"],
    ["ON", 1, "12399.00", "626.15"], ["ON", 10, "35102.50", "1772.68"],
    ["PE", 1, "13500.00", "1302.75"], ["PE", 10, "27100.00", "2615.15"],
    ["SK", 1, "18491.00", "1941.56"], ["SK", 10, "38721.00", "4065.71"],
    ["YT", 1, "15705.00", "1005.12"], ["YT", 10, "38697.50", "2476.64"],
  ]),
  ...provincialK1P(2025, 120, "2025-01-15", [
    ["AB", 1, "22323.00", "2232.30"], ["AB", 10, "49463.50", "4946.35"],
    ["BC", 1, "12932.00", "654.36"], ["BC", 10, "37667.00", "1905.95"],
    ["MB", 1, "15969.00", "1724.65"], ["MB", 10, "30359.50", "3278.83"],
    ["NB", 1, "13396.00", "1259.22"], ["NB", 10, "36711.50", "3450.88"],
    ["NL", 1, "11067.00", "962.83"], ["NL", 10, "31382.00", "2730.23"],
    // The January NS table prints CC10 as 2265.09, 1¢ below the formula
    // (25,769 × 0.0879 = 2,265.0951) while CC1 needs round-up; no single rule
    // yields that column. The July table prints the formula value, as here.
    ["NS", 1, "11744.00", "1032.30"], ["NS", 10, "25769.00", "2265.10"],
    ["NT", 1, "17842.00", "1052.68"], ["NT", 10, "43920.00", "2591.28"],
    ["NU", 1, "19274.00", "770.96"], ["NU", 10, "45768.50", "1830.74"],
    ["ON", 1, "12747.00", "643.72"], ["ON", 10, "36088.00", "1822.44"],
    ["PE", 1, "14250.00", "1353.75"], ["PE", 10, "27850.00", "2645.75"],
    ["SK", 1, "18991.00", "1994.06"], ["SK", 10, "39765.00", "4175.33"],
    ["YT", 1, "16129.00", "1032.26"], ["YT", 10, "39742.00", "2543.49"],
  ]),
  // July restatements: AB prorated 6%, MB prorated BPAMB, PE/SK prorated BPA.
  ...provincialK1P(2025, 121, "2025-08-14", [
    ["AB", 1, "22323.00", "1339.38"], ["AB", 10, "49463.50", "2967.81"],
    ["MB", 1, "15591.00", "1683.83"], ["MB", 10, "29981.50", "3238.00"],
    ["NS", 10, "25769.00", "2265.10"],
    ["PE", 1, "15050.00", "1429.75"], ["PE", 10, "28650.00", "2721.75"],
    ["SK", 1, "19991.00", "2099.06"], ["SK", 10, "40765.00", "4280.33"],
  ]),
  ...provincialK1P(2026, 122, "2026-01-15", [
    ["AB", 1, "22769.00", "1821.52"], ["AB", 10, "50453.50", "4036.28"],
    ["BC", 1, "13216.00", "668.73"], ["BC", 10, "38495.00", "1947.85"],
    ["MB", 1, "15780.00", "1704.24"], ["MB", 10, "30170.50", "3258.41"],
    ["NB", 1, "13664.00", "1284.42"], ["NB", 10, "37438.50", "3519.22"],
    ["NL", 1, "11188.00", "973.36"], ["NL", 10, "31724.00", "2759.99"],
    ["NS", 1, "11932.00", "1048.82"], ["NS", 10, "26178.00", "2301.05"],
    ["NT", 1, "18198.00", "1073.68"], ["NT", 10, "44794.50", "2642.88"],
    ["NU", 1, "19659.00", "786.36"], ["NU", 10, "46680.50", "1867.22"],
    ["ON", 1, "12989.00", "655.94"], ["ON", 10, "36772.00", "1856.99"],
    ["PE", 1, "15000.00", "1425.00"], ["PE", 10, "28600.00", "2717.00"],
    ["SK", 1, "20381.00", "2140.01"], ["SK", 10, "41571.50", "4365.01"],
    ["YT", 1, "16452.00", "1052.93"], ["YT", 10, "40532.50", "2594.08"],
  ]),
  // July: BC prorated 6.14%, NL prorated BPA.
  ...provincialK1P(2026, 123, "2026-07-15", [
    ["BC", 1, "13216.00", "811.46"], ["BC", 10, "38495.00", "2363.59"],
    ["NL", 1, "15000.00", "1305.00"], ["NL", 10, "35536.00", "3091.63"],
  ]),

  // ── Hand-worked stubs, 2024 ──────────────────────────────────────────────
  { year: 2024, label: "Ontario biweekly $2,000, claim code 1", citation: `hand-worked, ${ED[119]}`,
    input: { payDate: "2024-02-13", ...on26, income: "2000.00" },
    expected: { cpp: "110.99", cpp2: "0.00", ei: "33.20", eiEmployer: "46.48", periodicTax: "272.33" },
    // K2 = 0.15 × 2400.74 + 0.15 × 863.20; V2 = min(600, 450 + 0.25 × 3515.10); S = 0 as 2 × 286 < T4.
    expectedFactors: { F5: "18.6538", A: "51515.0012", K1: "2355.75", K2: "489.5913", K4: "214.95",
      T3: "4666.9589", T1: "4666.9589", K1P: "626.1495", K2P: "164.8291", T4: "1813.6440", V1: "0.00",
      V2: "600.00", S: "0.00", T2: "2413.6440" } },
  { year: 2024, label: "PEI biweekly $2,500, claim code 1 (new five-bracket system, no surtax)",
    citation: `hand-worked, ${ED[119]}`,
    input: { payDate: "2024-03-14", province: "PE", periodsPerYear: 26, ...cc1, income: "2500.00" },
    expected: { cpp: "140.74", ei: "41.50", eiEmployer: "58.10", periodicTax: "489.29" },
    // EI annualizes past the 1049.12 maximum: K2 = 0.15 × 3044.24 + 0.15 × 1049.12.
    expectedFactors: { F5: "23.6538", A: "64385.0012", K1: "2355.75", K2: "614.0043", T3: "6941.2209",
      K1P: "1302.75", K2P: "395.0094", T4: "5780.3433", V1: "0.00", T2: "5780.3433" } },
  { year: 2024, label: "Manitoba high earner keeps the flat BPA (BPAMB phase-out starts 2025)",
    citation: `hand-worked, ${ED[119]}`,
    input: { payDate: "2024-03-14", province: "MB", periodsPerYear: 26, income: "11538.46" },
    // A is past the 2025 phase-out band; BPAF floors at its 2024 minimum past $246,752.
    expectedFactors: { A: "297034.9538", TC: "14156.00", TCP: "15780.00" } },
  nsPhaseOut("2024-01-30", "9981.00", 119),

  // ── Hand-worked stubs, 2025 ──────────────────────────────────────────────
  { year: 2025, label: "Manitoba biweekly $2,500, claim code 1", citation: `hand-worked, ${ED[120]}`,
    input: { payDate: "2025-02-13", province: "MB", periodsPerYear: 26, ...cc1, income: "2500.00" },
    expected: { cpp: "140.74", cpp2: "0.00", ei: "41.00", eiEmployer: "57.40", periodicTax: "457.68" },
    expectedFactors: { F5: "23.6538", A: "64385.0012", K1: "2419.35", K2: "616.5363", K4: "220.65",
      T3: "6786.3889", T1: "6786.3889", K1P: "1724.6520", K2P: "443.9061", T4: "5113.5296", T2: "5113.5296" } },
  { year: 2025, label: "Manitoba no-TD1 default uses the January BPAMB", citation: `hand-worked, ${ED[120]}`,
    input: { payDate: "2025-02-13", province: "MB", periodsPerYear: 26, income: "2500.00" },
    expectedFactors: { TCP: "15969.00", TC: "16129.00" } },
  { year: 2025, label: "Manitoba no-TD1 default uses the July BPAMB", citation: `hand-worked, ${ED[121]}`,
    input: { payDate: "2025-08-14", province: "MB", periodsPerYear: 26, income: "2500.00" },
    expectedFactors: { TCP: "15591.00", TC: "16129.00" } },
  { year: 2025, label: "Alberta biweekly $3,000, claim code 1", citation: `hand-worked, ${ED[121]}`,
    input: { payDate: "2025-08-14", province: "AB", periodsPerYear: 26, ...cc1, income: "3000.00" },
    expected: { cpp: "170.49", ei: "49.20", eiEmployer: "68.88", periodicTax: "490.14" },
    // Annual CPP credit caps at 3356.10; EI annualizes past 1077.48.
    expectedFactors: { F5: "28.6538", A: "77255.0012", K1: "2258.06", K2: "620.7012", K4: "205.94",
      T3: "9023.5740", K1P: "1339.38", K2P: "266.0148", K5P: "0.00", T4: "3720.1053" } },
  { year: 2025, label: "Alberta July K5P supplemental credit (provincial claim 60,000)",
    citation: `hand-worked, ${ED[121]}`,
    input: { payDate: "2025-08-14", province: "AB", periodsPerYear: 26, federalClaimCode: 1,
      provincialClaim: "60000.00", income: "3000.00" },
    // K5P = (3600.00 + 266.0148 − 3600) × (2/3) = 177.3432.
    expected: { periodicTax: "396.37" }, expectedFactors: { K5P: "177.3432", T4: "1282.1421" } },
  nsPhaseOut("2025-01-30", "10244.00", 120),
  nsPhaseOut("2025-07-30", "11744.00", 121),

  // ── Hand-worked stubs, 2026 ──────────────────────────────────────────────
  { year: 2026, label: "Ontario biweekly $2,000, claim code 1", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", ...on26, income: "2000.00" },
    expected: { cpp: "110.99", cpp2: "0.00", ei: "32.60", eiEmployer: "45.64", f5: "18.65",
      periodicTax: "254.83", totalTax: "254.83" },
    // K2 = 0.14 × min(26 × 110.99 × 495/595, 3519.45) + 0.14 × min(26 × 32.60, 1123.07).
    expectedFactors: { A: "51515.0012", K2: "454.7678", T3: "4243.9124", T1: "4243.9124", T4: "1781.5218",
      V2: "600.00", T2: "2381.5218" } },
  { year: 2026, label: "Ontario biweekly $2,000 with a $28.85 labour-sponsored funds credit (capped at $750/yr)",
    citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", ...on26, income: "2000.00", labourFundsCreditFederal: "28.85" },
    expected: { periodicTax: "225.98" }, expectedFactors: { T1: "3493.9124" } },
  { year: 2026, label: "BC biweekly $2,000, claim code 1, June", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-06-15", province: "BC", periodsPerYear: 26, ...cc1, income: "2000.00" },
    expected: { edition: 122, periodicTax: "232.60" }, expectedFactors: { T4: "1803.5594" } },
  { year: 2026, label: "BC biweekly $2,000, claim code 1, July (prorated deduction)",
    citation: `hand-worked, ${ED[123]}`,
    input: { payDate: "2026-07-15", province: "BC", periodsPerYear: 26, ...cc1, income: "2000.00" },
    expected: { edition: 123, periodicTax: "246.68" }, expectedFactors: { T4: "2169.7446" } },
  { year: 2026, label: "CPP annual maximum and CPP2 band boundary", citation: `hand-worked, ${ED[123]}`,
    input: { payDate: "2026-11-06", province: "AB", periodsPerYear: 52, ...cc1, income: "3000.00",
      ytd: { cpp: "4200.00", pensionable: "73000.00" } },
    // C2: W = max(73,000, 74,600) = 74,600; band 76,000 − 74,600 = 1,400 → 0.04 × 1,400.
    expected: { cpp: "30.45", cpp2: "56.00", cppEmployer: "86.45" }, expectedFactors: { K2: "649.9528" } },
  { year: 2026, label: "EI annual maximum stops the premium at the cap", citation: `hand-worked, ${ED[123]}`,
    input: { payDate: "2026-11-06", province: "AB", periodsPerYear: 52, ...cc1, income: "3000.00",
      ytd: { ei: "1120.00" } },
    expected: { ei: "3.07" } },
  // The federal (TF) and provincial (TP) period legs round separately, as
  // bureau payroll withholds them; the period tax is their sum, a cent above
  // rounding (T1 + T2) / 12 once.
  { year: 2026, label: "bonus method: Ontario monthly $5,000 + $10,000 bonus", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-03-31", province: "ON", periodsPerYear: 12, ...cc1, income: "5000.00",
      nonPeriodic: "10000.00" },
    expected: { cpp: "875.15", f5A: "49.03", f5B: "98.05", periodicTax: "678.99", bonusTax: "2935.93",
      totalTax: "3614.92" },
    expectedFactors: { A: "69313.6080", A_step2: "59411.6640", TF: "434.34", TP: "244.65" } },
  { year: 2026, label: "bonus flat 15% when annual income is $5,000 or less", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-03-06", province: "ON", periodsPerYear: 52, ...cc1, income: "50.00",
      nonPeriodic: "400.00" },
    expected: { bonusTax: "60.00", periodicTax: "0.00" } },
  { year: 2026, label: "a non-pensionable bonus needs no enhanced-CPP allocation", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-03-06", province: "ON", periodsPerYear: 52, ...cc1,
      income: "0.00", nonPeriodic: "400.00", pensionable: "0.00", insurable: "0.00" },
    expected: { cpp: "0.00", cpp2: "0.00", f5: "0.00", f5A: "0.00", f5B: "0.00",
      bonusTax: "60.00", periodicTax: "0.00" } },
  { year: 2026, label: "BPAF phase-out when no federal TD1 is filed", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-01-30", province: "AB", periodsPerYear: 12, provincialClaimCode: 1,
      income: "20000.00" },
    // BPAF = 16452 − (237,635.04 − 181,440) × 1623/77042 = 15,268.17.
    expectedFactors: { TC: "15268.17", K1: "2137.5438" } },
  { year: 2026, label: "Quebec employment: QPP + QPIP + 16.5% abatement, no provincial T2",
    citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "QC", periodsPerYear: 26, federalClaimCode: 1, income: "2000.00" },
    expected: { cpp: "117.52", ei: "26.00", qpip: "8.60", qpipEmployer: "12.04" },
    expectedFactors: { T2: null, T3: "4212.8630", T1: "3517.7406" } },
  { year: 2026, label: "QPIP prices off its own insurable base below the EI leg", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "QC", periodsPerYear: 26, federalClaimCode: 1, income: "2000.00",
      insurable: "2000.00", qpipInsurable: "1500.00" },
    expected: { ei: "26.00", qpip: "6.45", qpipEmployer: "9.03" } },
  { year: 2026, label: "QPIP prices off its own insurable base above the EI leg", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "QC", periodsPerYear: 26, federalClaimCode: 1, income: "2000.00",
      insurable: "2000.00", qpipInsurable: "2500.00" },
    expected: { ei: "26.00", qpip: "10.75", qpipEmployer: "15.05" } },
  // Claim code E: no federal or provincial tax is deducted, and the Ontario
  // Health Premium is part of provincial tax; CPP and EI still apply.
  { year: 2026, label: "tax-exempt (claim code E) withholds no Ontario Health Premium",
    citation: `claim code E, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "ON", periodsPerYear: 26, income: "2500.00", taxExempt: true },
    expected: { periodicTax: "0.00", bonusTax: "0.00", cpp: "140.74", ei: "40.75" },
    expectedFactors: { T1: "0.00", T4: "0.00", V2: "0.00", T2: "0.00" } },
  { year: 2026, label: "tax-exempt (claim code E) withholds nothing from a small-income bonus",
    citation: `claim code E, ${ED[122]}`,
    input: { payDate: "2026-03-06", province: "ON", periodsPerYear: 52, income: "50.00",
      nonPeriodic: "1000.00", taxExempt: true },
    expected: { bonusTax: "0.00", periodicTax: "0.00", totalTax: "0.00" } },
  { year: 2026, label: "Manitoba BPAMB income phase-out", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-01-30", province: "MB", periodsPerYear: 12, federalClaimCode: 1, income: "20000.00" },
    // BPAMB = 15780 − (237,635.04 − 200,000) × 15780/200000.
    expectedFactors: { TCP: "12810.60" } },
  nsPhaseOut("2026-01-30", "11932.00", 122),
  { year: 2026, label: "Alberta K5P floors at zero below its threshold", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-01-30", province: "AB", periodsPerYear: 26, ...cc1, income: "2000.00" },
    expectedFactors: { K5P: "0.00" } },
  { year: 2026, label: "Alberta K5P supplemental credit (provincial claim 60,000)", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-01-30", province: "AB", periodsPerYear: 26, federalClaimCode: 1,
      provincialClaim: "60000.00", income: "8000.00" },
    // K5P = (0.08 × 60000 + 371.4016 − 4896) × 0.25.
    expectedFactors: { K5P: "68.8504" } },
  { year: 2026, label: "outside Canada (ZZ): 48% federal surtax, no provincial tax",
    citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "ZZ", periodsPerYear: 26, federalClaimCode: 1, income: "2000.00" },
    expectedFactors: { T3: "4243.9124", T1: "6280.9904", T2: null } },
  { year: 2026, label: "tiny weekly income yields no negative deductions", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", province: "ON", periodsPerYear: 52, ...cc1, income: "50.00" },
    // Below the $67.30 weekly CPP exemption; EI is first-dollar.
    expected: { cpp: "0.00", ei: "0.82", periodicTax: "0.00" } },
  { year: 2026, label: "additional per-period tax L applies even when A is nil", citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-02-13", ...on26, income: "0.00", additionalTaxPerPeriod: "25.00" },
    expected: { periodicTax: "25.00" } },
  { year: 2026, label: "single-month CPP proration (PM=1) still contributes and earns credits",
    citation: `hand-worked, ${ED[122]}`,
    input: { payDate: "2026-01-15", ...on26, cppMonths: 1, income: "2000.00" },
    // K2 = 0.14 × min(26 × 110.99 × 495/595, 3519.45/12) + 0.14 × 847.60: prorated, not zeroed.
    expected: { cpp: "110.99", periodicTax: "270.27" }, expectedFactors: { K2: "159.7243" } },
  // Ontario surtax is strictly above its $5,818 / $7,446 thresholds.
  { year: 2026, label: "Ontario surtax: T4 exactly on the first threshold", citation: `hand-worked, ${ED[122]}`,
    input: { ...onSurtax, income: "3374.5271" }, expectedFactors: { T4: "5818.00", V1: "0.00" } },
  { year: 2026, label: "Ontario surtax: just above the first threshold", citation: `hand-worked, ${ED[122]}`,
    input: { ...onSurtax, income: "3400.00" }, expectedFactors: { T4: "5878.60", V1: "12.12" } },
  { year: 2026, label: "Ontario surtax: above the second threshold", citation: `hand-worked, ${ED[122]}`,
    input: { ...onSurtax, income: "4500.00" }, expectedFactors: { T4: "8681.20", V1: "1017.3120" } },
];

// Expectations are cents unless written to four places (F5 keeps full precision).
const money = (value: string | number | null) =>
  value === null ? undefined : typeof value === "number" ? value : /\.\d{4}$/.test(value) ? value : `${value}00`;

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const result = calculateT4127(row.input);
    const where = (key: string) => `${row.year} ${row.label}: ${key} (${row.citation})`;
    for (const [key, want] of Object.entries(row.expected ?? {})) {
      assert.equal(result[key as ResultKey], money(want), where(key));
    }
    for (const [key, want] of Object.entries(row.expectedFactors ?? {})) {
      const actual = row.tabulatedCredits && (key === "K1" || key === "K1P")
        ? D(r2(U(result.factors[key]!))) : result.factors[key];
      assert.equal(actual, money(want), where(key));
    }
  });
}


test("annual provincial credits retain precision through the low-income reduction", () => {
  // T4127 Chapter 4: K1P = 12989 × .0505 = 655.9445. The K2P terms
  // retain their annual rate-ratio precision; rounding these credits before
  // applying Ontario's reduction changes the eventual period deduction.
  for (const [income, insurable, cppWithheld, eiWithheld, K2P, provincial, total] of [
    ["394.25", "388.64", "23.46", "6.33", "67.8746", "0.38", "3.07"],
    ["410.60", "381.76", "20.43", "6.22", "60.9662", "3.36", "8.78"],
  ]) {
    const result = calculateT4127({ payDate: "2026-01-09", province: "ON", periodsPerYear: 52,
      ...cc1, income, insurable, cppWithheld, eiWithheld });
    assert.equal(result.factors.K1P, "655.9445");
    assert.equal(result.factors.K2P, K2P);
    assert.equal(result.factors.TP, money(provincial));
    assert.equal(result.totalTax, money(total));
  }
});

test("the supplemental Alberta credit keeps the published repeating rate ratio", () => {
  const result = calculateT4127({ payDate: "2025-08-14", province: "AB", periodsPerYear: 26,
    federalClaimCode: 1, provincialClaim: "90000.00", income: "3000.00" });
  // (5400 + 266.0148 - 3600) × 2/3, not a six-place approximation.
  assert.equal(result.factors.K5P, "1377.3432");
});

test("a reduced employer EI multiple prices the employee premium times the multiple", () => {
  // The 2024 Ontario biweekly $2,000 hand-worked stub prices EI 33.20 and
  // 46.48 at the statutory 1.4. At a CRA-approved 1.167 the same premium
  // prices 33.20 x 1.167 = 38.7444, half-up to 38.74.
  const reduced = calculateT4127({
    payDate: "2024-02-13", ...on26, income: "2000.00", eiEmployerMultiple: "1.167",
  });
  assert.equal(reduced.ei, money("33.20"));
  assert.equal(reduced.eiEmployer, money("38.74"));
  const standard = calculateT4127({ payDate: "2024-02-13", ...on26, income: "2000.00" });
  assert.equal(standard.eiEmployer, money("46.48"));
});

test("an employer EI multiple outside 1.0000-1.4000 or past 4 places refuses", () => {
  const bad: [string, string][] = [
    ["1.16755", "five places"],
    ["1.5", "above the statutory multiple"],
    ["0.9999", "below one"],
    ["abc", "not a number"],
  ];
  for (const [multiple, label] of bad) {
    assert.throws(
      () => calculateT4127({ payDate: "2024-02-13", ...on26, income: "2000.00", eiEmployerMultiple: multiple }),
      /employer EI multiple/,
      label,
    );
  }
});

test("edition resolution by pay date", () => {
  const EDITIONS: [string, Edition][] = [
    ["2024-01-01", 119], ["2024-12-31", 119], ["2025-01-01", 120], ["2025-06-30", 120],
    ["2025-07-01", 121], ["2025-12-31", 121], ["2026-01-01", 122], ["2026-06-30", 122],
    ["2026-07-01", 123], ["2026-12-31", 123],
  ];
  for (const [payDate, edition] of EDITIONS) {
    assert.equal(ratesForPayDate(payDate).edition, edition, `${payDate} resolves to ${ED[edition]}`);
  }
});

const REFUSALS: { label: string; payDate: string; refusal: RegExp }[] = [
  { label: "pay date after the last published edition", payDate: "2027-01-01",
    refusal: /no T4127 constants for pay date 2027-01-01/ },
  { label: "pay date before the first published edition", payDate: "2023-12-31",
    refusal: /no T4127 constants for pay date 2023-12-31/ },
];
for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, () => {
    assert.throws(() => ratesForPayDate(row.payDate), row.refusal, row.label);
  });
}

test("every published edition's constants are transcribed, not scaffolded", () => {
  for (const [name, rates] of Object.entries({ RATES_2024_JAN, RATES_2025_JAN, RATES_2025_JUL })) {
    assert.deepEqual(unfilledPaths(rates), [], `transcribe every ${name} figure from T4127`);
  }
});

test("123rd edition leaves untouched provinces identical to the 122nd", () => {
  for (const province of ["AB", "MB", "NB", "NS", "NT", "NU", "ON", "SK", "YT"] as const) {
    assert.deepEqual(RATES_2026_JUL.provinces[province], RATES_2026_JAN.provinces[province]);
  }
});

test("Canada withholding uses effective TD1ON dependants and TP-1015 fund purchases", async () => {
  const tax = async (region: "ON" | "QC", answers?: Record<string, string>) => {
    const certificate = payrollCertificate("CA", `ca_td1_${region}`);
    const row: StoredCertificate | null = answers ? {
      certificateKey: certificate.key, region, subRegion: null, answers,
      effectiveFrom: "2026-01-01", supersededOn: null,
    } : null;
    const resolved = resolveCertificate({ certificate, stored: row ? [row] : [],
      profile: { federal_claim_code: "1", provincial_claim_code: "1" }, asOf: "2026-02-13" });
    const taxes: Record<string, string> = {};
    await computeCaStatutory({ tx: { execute: async () => ({ rows: [{
      pensionable: "0", insurable: "0", cpp: "0", cpp2: "0", ei: "0", qpip: "0",
      qpip_employer: "0", non_periodic: "0", f5b: "0", qc_csb: "0",
    }] }) } as never, orgId: "org", documentId: "run", employeePartyId: "employee",
    employeeName: "Test Employee", taxYear: 2026, country: "CA", region,
    run: { pay_date: "2026-02-13" }, emp: { federal_claim_code: "1", provincial_claim_code: "1" },
    filingAccountId: null, periodsPerYear: 26, income: "1100.0000", nonPeriodic: "0.0000",
    pensionable: "1100.0000", insurable: "1100.0000", deduction: () => "0.0000",
    pushStatutory: (slot: string, _kind: string, _label: string, amount: string) => {
      taxes[slot] = amount;
    }, storedCertificates: row ? [row] : [],
    certificateFor: (key: string) => key === certificate.key ? resolved : null,
    bool: () => false, assertRegionSupported: () => undefined,
    employerLevies: { wcbAmount: "0", wcbAssessable: "0", ehtAmount: "0", ehtEarnings: "0",
      hsfAmount: "0", hsfEarnings: "0", cntAmount: "0", cntEarnings: "0" },
    } as never);
    return taxes;
  };
  assert.ok(cmp((await tax("ON", { disabled_dependants: "0", dependants_under_19: "1" })).income_tax ?? assert.fail("no ON income tax"),
    (await tax("ON")).income_tax ?? assert.fail("no ON income tax")) < 0);
  const withFunds = await tax("QC", { ftq_shares_per_period: "100", fondaction_shares_per_period: "150" });
  assert.deepEqual([withFunds.income_tax, withFunds.qc_income_tax], ["9.6900", "13.9500"]);
});

test("a bonus never reduces the default basic personal amount of the step without it", () => {
  // No TD1 on file: BPAF phases out on each step's own net income (NI = A + HD).
  // Step 2 (A 178,255.20) sits below the 181,440 phase-out start and keeps the full
  // 16,452, so the periodic tax only moves by the enhanced-CPP split the bonus changes;
  // step 1 (A 237,673.60) takes the phased 15,267.36. Pricing step 2 on step 1's
  // claim would cost the periodic tax 1,184.64 × 14% / 12 ≈ 13.82 more.
  const base = { payDate: "2026-03-31", province: "ON", periodsPerYear: 12, income: "15000.00" } as const;
  const plain = calculateT4127(base);
  const withBonus = calculateT4127({ ...base, nonPeriodic: "60000.00" });
  assert.equal(plain.periodicTax, "4424.7900");
  assert.equal(withBonus.periodicTax, "4425.5500");
  assert.equal(withBonus.bonusTax, "28997.9800");
  assert.equal(withBonus.factors.TC, "15267.3600");
});

test("federal and provincial tax round to the cent separately before they add", () => {
  // 0.26 a year over 52 periods is half a cent on each leg: each leg rounds
  // up to 0.01, so the period owes 0.02 where rounding the combined 0.52
  // once would owe 0.01.
  const legs = periodTaxLegs(U("0.26"), U("0.26"), 52);
  assert.equal(legs.federal + legs.provincial, U("0.02"));
  assert.equal(legs.federal, U("0.01"));
})
