/**
 * GB gold-parity harness for the PAYE/NIC engine (calculate.ts), every
 * transcribed year in one table.
 *
 * - GOLDENS: HMRC's own worked examples (CWG2's Jason, the K475 and 1257L
 *   guide examples, Tax Tables B-D) and cases hand-worked from the published
 *   tables, one row per year, including the rows that discriminate a year
 *   from its neighbours (employer 13.8% and £9,100 ST in 2024/25 against 15%
 *   and £5,000 from 2025/26; each year's Scottish starter/basic tops).
 * - TRANSCRIPTIONS: each prior year's tables against the quoted figures.
 * - REFUSALS: pay dates outside every transcribed year, gapped cumulative
 *   records and loan plans outside their years are refused by name.
 * - Helper tables (Cvalues, Tables-A, penny rounding) and monotonicity sweeps.
 * Scottish 2026/27 goldens live in parity-scotland.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { add, fromUnits, toUnits } from "../../money/money.ts";
import {
  calculateGbLoanDeductions,
  calculateGbNic,
  calculateGbPaye,
  gbCvalueUnits,
  gbNicThresholdsForPeriod,
  gbResolveTaxYear,
  gbRoundPennyUnits,
  gbRukLiabilityUnits,
  gbSctLiabilityUnits,
  gbTablesAValueUnits,
  gbTaxMonthNumber,
  gbTaxWeekNumber,
  resolveGbCumulativeBasis,
} from "./calculate.ts";
import * as rates2024 from "./rates-2024.ts";
import * as rates2025 from "./rates-2025.ts";
import { GB_TAX_YEARS } from "./rates.ts";
import { parseGbTaxCode } from "./tax-codes.ts";
import { unfilledPaths } from "../unfilled.ts";
import { gbTablesForTaxYear, type GbYearTables } from "./year-tables.ts";

type Input =
  | { kind: "liability"; taxable: string }
  | { kind: "nic"; earnings: string; periodsPerYear: number }
  | { kind: "paye"; code: string; payDate: string; pay: string; periodsPerYear: number; priors?: [string, string] }
  | { kind: "paye-year"; code: string; monthlyPay: string }
  | { kind: "loan"; earnings: string; periodsPerYear: number; plan: string; postgraduate: boolean };

interface Golden {
  region?: "SCT" | "WLS";
  year: number;
  label: string;
  input: Input;
  /** Only the outputs the source states; each is asserted to the 4dp unit. */
  expected: Record<string, string>;
  citation: string;
}

const liability = (taxable: string): Input => ({ kind: "liability", taxable });
const nic = (earnings: string, periodsPerYear = 12): Input => ({ kind: "nic", earnings, periodsPerYear });
const paye = (code: string, payDate: string, pay: string, periodsPerYear = 12, priors?: [string, string]): Input =>
  ({ kind: "paye", code, payDate, pay, periodsPerYear, priors });
const loan = (plan: string, earnings = "3000", periodsPerYear = 12, postgraduate = false): Input =>
  ({ kind: "loan", earnings, periodsPerYear, plan, postgraduate });

const CWG2 = "CWG2 2026/27 (Jason, exact percentage method)";
const SPEC = "HMRC PAYE software specification, hand-worked";
const TABLES_BD = "HMRC Tax Tables B-D (manual method, 2023/24 print; rUK bands unchanged since)";
const LOANS = "HMRC student-loan collection spec: per-period NIC pay, threshold ÷ periods floored, deduction floored to £";
const R2024 = "HMRC Rates and thresholds for employers 2024 to 2025, hand-worked";
const R2025 = "HMRC Rates and thresholds for employers 2025 to 2026, hand-worked";

const GOLDENS: readonly Golden[] = [
  // ---- 2026/27 --------------------------------------------------------------
  { year: 2026, label: "weekly £300 NIC (Jason)", input: nic("300", 52), expected: { employee: "4.64", employer: "30.60" },
    citation: `${CWG2}: (£300 – £242) × 8% = £4.64; category-A employer (300 − 96) × 15% (Jason's £0.00 is category M)` },
  { year: 2026, label: "weekly £2,300 NIC (Jason combined week)", input: nic("2300", 52), expected: { employee: "84.66" },
    citation: `${CWG2}: £725 × 8% = £58.00; £1,333 × 2% = £26.66; £84.66` },
  { year: 2026, label: "K475 on £27,000 prices £31,750", input: liability("31750"), expected: { liability: "6350" },
    citation: "HMRC tax-code letters page: K475 and £27,000 has taxable income of £31,750" },
  { year: 2026, label: "1257L on £27,000 prices £14,430", input: liability("14430"), expected: { liability: "2886" },
    citation: "HMRC tax-code numbers page: 1257L earning £27,000 has taxable income of £14,430" },
  { year: 2026, label: "BR £3,200", input: paye("BR", "2026-07-06", "3200"), expected: { tax: "640" },
    citation: `${TABLES_BD} Example 2: £3,200 x 0.20 = £640.00` },
  { year: 2026, label: "1257L month 3 £4,000, no priors", input: paye("1257L", "2026-06-06", "4000"), expected: { tax: "171" },
    citation: `${SPEC} §4: free pay 3 × £1,048.26, Tn £855 × 20% (Formula 1)` },
  { year: 2026, label: "monthly £2,000 employer NIC", input: nic("2000"), expected: { employer: "237.45" },
    citation: `${SPEC}: (2,000 − 417) × 15%` },
  { year: 2026, label: "monthly £1,048 is exactly PT", input: nic("1048"), expected: { employee: "0" }, citation: `${SPEC}: nothing due at PT` },
  { year: 2026, label: "monthly £4,189 is exactly UEL", input: nic("4189"), expected: { employee: "251.28" }, citation: `${SPEC}: 3,141 × 8%` },
  { year: 2026, label: "monthly £5,000 crosses UEL", input: nic("5000"), expected: { employee: "267.50" }, citation: `${SPEC}: 251.28 + 811 × 2%` },
  { year: 2026, label: "full year £27,000 1257L", input: { kind: "paye-year", code: "1257L", monthlyPay: "2250" },
    expected: { month1: "240.20", total: "2884" },
    citation: `${SPEC}: months ripple ±41p but the year telescopes to Tn £14,420 (27,000 − 12 × 1,048.26) × 20%` },
  { year: 2026, label: "K2000 month 12 £500 is capped at half of pay", input: paye("K2000", "2027-03-06", "500"), expected: { tax: "250" },
    citation: `${SPEC} §4.5.2 Maxrate: added pay £20,000.16 to date, deduction held at 50% of £500` },
  { year: 2026, label: "0T month 2 £5,000", input: paye("0T", "2026-05-06", "5000"), expected: { tax: "1000" }, citation: `${SPEC}: £5,000 × 20%` },
  { year: 2026, label: "NT month 2 £5,000", input: paye("NT", "2026-05-06", "5000"), expected: { tax: "0" }, citation: `${SPEC}: NT prices nothing` },
  // Example 5: Formula 2 on the exact month-4 threshold £12,566.6666 / £2,513.3333 → £5,606.6666, floored.
  { year: 2026, label: "Tax Tables B-D Example 5 (0T month 4, Tn £20,300)", input: paye("0T", "2026-07-06", "20300"),
    expected: { tax: "5606.66" }, citation: `${TABLES_BD} pp.7–8 Example 5: £3,093.20 + £2,513.46` },
  { year: 2026, label: "Tax Tables B-D Example 6 (0T month 4, Tn £49,214)", input: paye("0T", "2026-07-06", "49214"),
    expected: { tax: "17547.30" }, citation: `${TABLES_BD} pp.7–8 Example 6: £3,375.00 + £14,172.30` },
  // Month 1 prices Formula 2 on the exact threshold 37,700/12; the printed £3,142 Cvalue would give £2,952.30.
  { year: 2026, label: "1257L £10,000 in month 1", input: paye("1257L", "2026-04-06", "10000"), expected: { tax: "2952.06" },
    citation: `${SPEC} §4.4.4 / §2.5: £628.3333 + 5,809.3334 × 40%, floored` },
  { year: 2026, label: "month-7 cumulative higher earner", input: paye("1257L", "2026-10-06", "10000", 12, ["60000", "17714"]),
    expected: { tax: "2952.46" }, citation: `${SPEC}: Formula 2 to date £20,666.46 less £17,714.00 paid` },
  { year: 2026, label: "week 53 prices non-cumulatively on Week 1", input: paye("1257L", "2027-04-05", "2250", 52, ["99999", "9999"]),
    expected: { tax: "658.20" }, citation: `${SPEC} §14: £145.00 + 1,283 × 40%, priors ignored` },
  { year: 2026, label: "1257L W1 weekly £2,500", input: paye("1257L W1", "2026-04-08", "2500", 52), expected: { tax: "758.20" },
    citation: `${SPEC}: free £241.92, £145.00 + 1,533 × 40%` },
  { year: 2026, label: "full year £60,000 1257L", input: { kind: "paye-year", code: "1257L", monthlyPay: "5000" },
    expected: { month1: "952.06", total: "11428" }, citation: `${SPEC}: telescopes to Tn £47,420: £7,540 + 9,720 × 40%` },
  { year: 2026, label: "K475 M1 £2,250 prices added pay through month-1 bands", input: paye("K475 M1", "2026-07-06", "2250"),
    expected: { tax: "529", periodAddedPay: "395.84" }, citation: `${SPEC} §4.3.1c: added ceiling(4,750/12), Formula 1, cap unbound` },
  { year: 2026, label: "1257L W1 ignores year to date", input: paye("1257L W1", "2027-03-06", "2250", 12, ["20000", "9999.99"]),
    expected: { tax: "240.20" }, citation: `${SPEC}: period-only, Tn £1,201 × 20%` },
  { year: 2026, label: "NIC exactly a half-penny rounds down", input: nic("242.0625", 52), expected: { employee: "0" },
    citation: "Regulation 12(1): £0.005 is disregarded" },
  { year: 2026, label: "NIC just over a half-penny rounds up", input: nic("242.0638", 52), expected: { employee: "0.01" },
    citation: "Regulation 12(1): £0.005104 → £0.01" },
  { year: 2026, label: "sweep: a penny below £37,700", input: liability("37699.99"), expected: { liability: "7539.998" }, citation: "rUK basic top" },
  { year: 2026, label: "sweep: at £37,700", input: liability("37700"), expected: { liability: "7540" }, citation: "rUK basic top" },
  { year: 2026, label: "sweep: a penny above £37,700", input: liability("37700.01"), expected: { liability: "7540.004" }, citation: "rUK basic top" },
  { year: 2026, label: "sweep: a penny below £125,140", input: liability("125139.99"), expected: { liability: "42515.996" },
    citation: "additional threshold: 7,540 + 87,440 × 40% = £42,516" },
  { year: 2026, label: "sweep: at £125,140", input: liability("125140"), expected: { liability: "42516" }, citation: "additional threshold" },
  { year: 2026, label: "sweep: a penny above £125,140", input: liability("125140.01"), expected: { liability: "42516.0045" }, citation: "additional threshold" },
  { year: 2026, label: "sweep: weekly £241.99", input: nic("241.99", 52), expected: { employee: "0" }, citation: "below PT" },
  { year: 2026, label: "sweep: weekly £242", input: nic("242", 52), expected: { employee: "0" }, citation: "at PT" },
  { year: 2026, label: "sweep: weekly £242.50", input: nic("242.50", 52), expected: { employee: "0.04" }, citation: "above PT" },
  { year: 2026, label: "sweep: weekly £95.99", input: nic("95.99", 52), expected: { employer: "0" }, citation: "below ST" },
  { year: 2026, label: "sweep: weekly £96", input: nic("96", 52), expected: { employer: "0" }, citation: "at ST" },
  { year: 2026, label: "sweep: weekly £100", input: nic("100", 52), expected: { employer: "0.60" }, citation: "above ST" },
  { year: 2026, label: "sweep: weekly £967", input: nic("967", 52), expected: { employee: "58" }, citation: "at UEL" },
  { year: 2026, label: "sweep: weekly £968", input: nic("968", 52), expected: { employee: "58.02" }, citation: "above UEL" },
  { year: 2026, label: "Plan 2 monthly £3,000", input: loan("plan_2"), expected: { studentLoan: "49", postgraduateLoan: "0" }, citation: LOANS },
  { year: 2026, label: "Plan 2 weekly £1,000", input: loan("plan_2", "1000", 52), expected: { studentLoan: "39" },
    citation: `${LOANS}: floor(£29,385 / 52) = £565.09; (1,000 − 565.09) × 9% = £39.14` },
  { year: 2026, label: "Plan 2 with a concurrent postgraduate loan", input: loan("plan_2", "3000", 12, true),
    expected: { studentLoan: "49", postgraduateLoan: "75" }, citation: LOANS },
  { year: 2026, label: "Plan 1 monthly £3,000", input: loan("plan_1"), expected: { studentLoan: "68", postgraduateLoan: "0" }, citation: LOANS },
  { year: 2026, label: "Plan 4 monthly £3,000", input: loan("plan_4"), expected: { studentLoan: "16", postgraduateLoan: "0" }, citation: LOANS },
  { year: 2026, label: "Plan 5 monthly £3,000", input: loan("plan_5"), expected: { studentLoan: "82", postgraduateLoan: "0" }, citation: LOANS },
  { year: 2026, label: "postgraduate loan alone", input: loan("none", "3000", 12, true), expected: { studentLoan: "0", postgraduateLoan: "75" },
    citation: LOANS },
  { year: 2025, label: "Plan 1 monthly £3,000", input: loan("plan_1"), expected: { studentLoan: "74" }, citation: LOANS },
  { year: 2024, label: "Plan 1 monthly £3,000", input: loan("plan_1"), expected: { studentLoan: "82" },
    citation: `${LOANS}: floor((3000 − floor(24990/12)) × 9%)` },

  // ---- 2025/26 --------------------------------------------------------------
  { year: 2025, label: "1257L on £27,000 prices £14,430", input: liability("14430"), expected: { liability: "2886" }, citation: `${R2025}: 14,430 × 20%` },
  { year: 2025, label: "K475 on £27,000 prices £31,750", input: liability("31750"), expected: { liability: "6350" }, citation: `${R2025}: 31,750 × 20%` },
  { region: "SCT", year: 2025, label: "Scotland: S1257L on £27,000", input: liability("14430"), expected: { liability: "2857.73" },
    citation: `${R2025}: starter 2,827 × 19% = £537.13; 11,603 × 20% = £2,320.60` },
  { region: "SCT", year: 2025, label: "Scotland: S1257L on £60,000", input: liability("47430"), expected: { liability: "13213.80" },
    citation: `${R2025}: £537.13 + 12,094 × 20% + 16,171 × 21% + 16,338 × 42%` },
  { year: 2025, label: "monthly £4,000 NIC", input: nic("4000"), expected: { employee: "236.16", employer: "537.45" },
    citation: `${R2025}: 2,952 × 8%; employer (4,000 − 417) × 15%` },
  { year: 2025, label: "weekly £300 NIC", input: nic("300", 52), expected: { employee: "4.64", employer: "30.60" },
    citation: `${R2025}: 58 × 8%; employer (300 − 96) × 15%` },
  { year: 2025, label: "weekly £2,300 NIC", input: nic("2300", 52), expected: { employee: "84.66", employer: "330.60" },
    citation: `${R2025}: £58.00 + £26.66; employer 2,204 × 15%` },
  { year: 2025, label: "1257L month 3 £4,000, no priors", input: paye("1257L", "2025-06-06", "4000"), expected: { tax: "171" },
    citation: `${R2025}: free pay 3 × £1,048.26 (Tables A), Tn £855 × 20%` },
  // Starter top £2,827: Formula 2 on £706.75 / £134.2825, + (855 − 706.75) × 20% → £163.9325, floored.
  { region: "SCT", year: 2025, label: "Scotland: S1257L month 3 £4,000", input: paye("S1257L", "2025-06-06", "4000"),
    expected: { tax: "163.93" }, citation: `${R2025}: month-3 Income Test 1 fails (855.22 > Cvalue £707)` },
  { region: "WLS", year: 2025, label: "Wales: C1257L month 3 prices as 1257L", input: paye("C1257L", "2025-06-06", "4000"),
    expected: { tax: "171" }, citation: "welsh-income-tax 2025 to 2026: rates set by the Welsh Government, identical to rUK" },
  { year: 2025, label: "BR £3,200", input: paye("BR", "2025-07-06", "3200"), expected: { tax: "640" }, citation: `${R2025}: flat 20%` },
  { region: "SCT", year: 2025, label: "sweep: Scottish starter top £2,827", input: liability("2827"),
    expected: { liability: "537.13", nextPound: "0.20" }, citation: `${R2025}: the 2,828th pound prices at 20%` },
  { region: "SCT", year: 2025, label: "sweep: Scottish top threshold £125,140", input: liability("125140"),
    expected: { nextPound: "0.48" }, citation: `${R2025}: the 125,141st pound prices at 48%` },
  { year: 2025, label: "sweep: rUK basic top £37,700", input: liability("37700"), expected: { liability: "7540", nextPound: "0.40" },
    citation: `${R2025}: the next pound prices at 40%` },

  // ---- 2024/25 --------------------------------------------------------------
  { year: 2024, label: "1257L on £27,000 prices £14,430", input: liability("14430"), expected: { liability: "2886" }, citation: `${R2024}: 14,430 × 20%` },
  { year: 2024, label: "K475 on £27,000 prices £31,750", input: liability("31750"), expected: { liability: "6350" }, citation: `${R2024}: 31,750 × 20%` },
  { region: "SCT", year: 2024, label: "Scotland: S1257L on £27,000", input: liability("14430"), expected: { liability: "2867.33" },
    citation: `${R2024}: £438.14 + 11,685 × 20% + 439 × 21% (overshoots the £13,991 basic top)` },
  { region: "SCT", year: 2024, label: "Scotland: S1257L on £60,000", input: liability("47430"), expected: { liability: "13228.31" },
    citation: `${R2024}: £438.14 + 11,685 × 20% + 17,101 × 21% + 16,338 × 42%` },
  { year: 2024, label: "monthly £4,000 NIC", input: nic("4000"), expected: { employee: "236.16", employer: "447.40" },
    citation: `${R2024}: 2,952 × 8%; employer 3,242 × 13.8% = £447.396, rounded up` },
  { year: 2024, label: "weekly £300 NIC", input: nic("300", 52), expected: { employee: "4.64", employer: "17.25" },
    citation: `${R2024}: 58 × 8%; employer (300 − 175) × 13.8%` },
  { year: 2024, label: "weekly £2,300 NIC", input: nic("2300", 52), expected: { employee: "84.66", employer: "293.25" },
    citation: `${R2024}: £58.00 + £26.66; employer 2,125 × 13.8%` },
  { year: 2024, label: "1257L month 3 £4,000, no priors", input: paye("1257L", "2024-06-06", "4000"), expected: { tax: "171" },
    citation: `${R2024}: free pay 3 × £1,048.26 (Tables A), Tn £855 × 20%` },
  // Starter top £2,306: Formula 2 on £576.50 / £109.5350, + (855 − 576.50) × 20% → £165.2350, floored.
  { region: "SCT", year: 2024, label: "Scotland: S1257L month 3 £4,000", input: paye("S1257L", "2024-06-06", "4000"),
    expected: { tax: "165.23" }, citation: `${R2024}: month-3 Income Test 1 fails (855.22 > Cvalue £577)` },
  { region: "WLS", year: 2024, label: "Wales: C1257L month 3 prices as 1257L", input: paye("C1257L", "2024-06-06", "4000"),
    expected: { tax: "171" }, citation: "welsh-income-tax 2024 to 2025: rates set by the Welsh Government, identical to rUK" },
  { year: 2024, label: "BR £3,200", input: paye("BR", "2024-07-06", "3200"), expected: { tax: "640" }, citation: `${R2024}: flat 20%` },
  { region: "SCT", year: 2024, label: "sweep: Scottish starter top £2,306", input: liability("2306"),
    expected: { liability: "438.14", nextPound: "0.20" }, citation: `${R2024}: the 2,307th pound prices at 20%` },
  { region: "SCT", year: 2024, label: "sweep: Scottish basic top £13,991", input: liability("13991"),
    expected: { nextPound: "0.21" }, citation: `${R2024}: the next pound prices at 21%` },
  { region: "SCT", year: 2024, label: "sweep: Scottish top threshold £125,140", input: liability("125140"),
    expected: { nextPound: "0.48" }, citation: `${R2024}: the 125,141st pound prices at 48%` },
  { year: 2024, label: "sweep: rUK basic top £37,700", input: liability("37700"), expected: { liability: "7540", nextPound: "0.40" },
    citation: `${R2024}: the next pound prices at 40%` },
];

/** Twelve monthly pay dates (the 6th) from the tax year's start. */
function monthlyPayDates(tables: GbYearTables): string[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = 3 + index;
    return `${tables.year + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}-06`;
  });
}

function compute(row: Golden): Record<string, string> {
  const tables = gbTablesForTaxYear(row.year);
  const { input } = row;
  switch (input.kind) {
    case "liability": {
      const priced = (units: bigint) =>
        (row.region === "SCT" ? gbSctLiabilityUnits : gbRukLiabilityUnits)(units, tables);
      const taxable = toUnits(input.taxable);
      return { liability: fromUnits(priced(taxable)), nextPound: fromUnits(priced(taxable + toUnits("1")) - priced(taxable)) };
    }
    case "nic":
      return { ...calculateGbNic({ earnings: input.earnings, periodsPerYear: input.periodsPerYear, tables }) };
    case "paye": {
      const [priorTaxablePay, priorTaxPaid] = input.priors ?? ["0", "0"];
      const result = calculateGbPaye({
        code: parseGbTaxCode(input.code), payDate: input.payDate, periodsPerYear: input.periodsPerYear,
        periodPay: input.pay, priorTaxablePay, priorAddedPay: "0", priorTaxPaid, periodGrossPay: input.pay, tables,
      });
      return { tax: result.tax, periodAddedPay: result.periodAddedPay };
    }
    case "paye-year": {
      const code = parseGbTaxCode(input.code);
      const taxes: string[] = [];
      let priorTaxablePay = "0";
      let priorTaxPaid = "0";
      for (const payDate of monthlyPayDates(tables)) {
        const { tax } = calculateGbPaye({
          code, payDate, periodsPerYear: 12, periodPay: input.monthlyPay, priorTaxablePay,
          priorAddedPay: "0", priorTaxPaid, periodGrossPay: input.monthlyPay, tables,
        });
        taxes.push(tax);
        priorTaxablePay = add(priorTaxablePay, input.monthlyPay);
        priorTaxPaid = add(priorTaxPaid, tax);
      }
      return { month1: taxes[0]!, total: priorTaxPaid };
    }
    case "loan":
      return { ...calculateGbLoanDeductions({
        earnings: input.earnings, periodsPerYear: input.periodsPerYear, taxYear: row.year,
        studentLoanPlan: input.plan, postgraduateLoan: input.postgraduate,
      }) };
  }
}

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const actual = compute(row);
    for (const [output, figure] of Object.entries(row.expected)) {
      assert.equal(actual[output], fromUnits(toUnits(figure)), `${row.year} ${row.label}: ${output} — ${row.citation}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Refusals: never extrapolated, never priced from zero on a gapped record
// ---------------------------------------------------------------------------

type Basis = Parameters<typeof resolveGbCumulativeBasis>[0];
type RefusalInput =
  | { kind: "year"; payDate: string }
  | { kind: "basis"; basis: Basis }
  | { kind: "loan"; year: number; plan: string };

const basis = (payDate: string, starterDeclaration: Basis["starterDeclaration"], minStubPayDate: string | null,
  hasStubs = minStubPayDate != null, monthOneEnd?: string): Basis =>
  ({ payDate, starterDeclaration, hasStubs, minStubPayDate, monthOneEnd });
const GAPPED = /complete in-year record/;
const NO_TABLES = /no transcribed tables/;

const REFUSALS: readonly { label: string; input: RefusalInput; refusal: RegExp }[] = [
  { label: "2024-04-05 falls in 2023/24", input: { kind: "year", payDate: "2024-04-05" },
    refusal: /no transcribed tables for pay date 2024-04-05/ },
  ...["2027-04-06", "2023-06-06", "2028-01-01", "2027-06-06"].map((payDate) =>
    ({ label: `${payDate} is outside every transcribed year`, input: { kind: "year" as const, payDate }, refusal: NO_TABLES })),
  { label: "P45 joiner with nothing on file after month 1", input: { kind: "basis", basis: basis("2026-11-06", null, null) }, refusal: GAPPED },
  { label: "mid-year adopter whose stubs start in October", input: { kind: "basis", basis: basis("2026-11-06", null, "2026-10-06") },
    refusal: GAPPED },
  { label: "declaration B: old-employer pay outside the product", input: { kind: "basis", basis: basis("2026-11-06", "B", "2026-08-06") },
    refusal: GAPPED },
  { label: "declaration C with no stubs yet", input: { kind: "basis", basis: basis("2026-11-06", "C", null) }, refusal: GAPPED },
  { label: "2024/25 month 3 with no record", input: { kind: "basis", basis: basis("2024-06-06", null, null, false, "2024-05-05") },
    refusal: GAPPED },
  { label: "2025/26 month 3 with no record", input: { kind: "basis", basis: basis("2025-06-06", null, null, false, "2025-05-05") },
    refusal: GAPPED },
  { label: "Plan 5 before it applied", input: { kind: "loan", year: 2025, plan: "plan_5" }, refusal: /Plan 5.*did not apply in tax year 2025/ },
];

for (const { label, input, refusal } of REFUSALS) {
  test(`refused: ${label}`, () => {
    assert.throws(() => {
      if (input.kind === "year") gbResolveTaxYear(input.payDate);
      else if (input.kind === "basis") resolveGbCumulativeBasis(input.basis);
      else calculateGbLoanDeductions({
        earnings: "3000", periodsPerYear: 12, taxYear: input.year, studentLoanPlan: input.plan, postgraduateLoan: false,
      });
    }, refusal, label);
  });
}

test("a complete record computes cumulatively: month 1, declaration A, C with stubs, stubs spanning the year start", () => {
  for (const allowed of [
    basis("2026-04-06", null, null), basis("2026-11-06", "A", null), basis("2026-11-06", "C", "2026-08-06"),
    basis("2026-11-06", null, "2026-04-06"), basis("2024-04-20", null, null, false, "2024-05-05"),
    basis("2025-04-20", null, null, false, "2025-05-05"),
  ]) assert.doesNotThrow(() => resolveGbCumulativeBasis(allowed), allowed.payDate);
});

// ---------------------------------------------------------------------------
// Prior-year transcriptions and edition resolution
// ---------------------------------------------------------------------------

const RUK_FROZEN = [{ upTo: "37700", rate: "0.20" }, { upTo: "125140", rate: "0.40" }, { upTo: null, rate: "0.45" }];
const sctBands = (starter: string, basic: string) => [
  { upTo: starter, rate: "0.19" }, { upTo: basic, rate: "0.20" }, { upTo: "31092", rate: "0.21" },
  { upTo: "62430", rate: "0.42" }, { upTo: "125140", rate: "0.45" }, { upTo: null, rate: "0.48" },
];
const nicThresholds = (lel: string, pt: string, st: string, uel: string) => ({ lel, pt, st, uel });

const TRANSCRIPTIONS = [
  { year: 2024, module: rates2024 as Record<string, unknown>,
    citation: "HMRC Rates and thresholds for employers 2024 to 2025; scottish-income-tax; income-tax-rates (Sept 2024); DWP AE review 2024/25",
    tables: {
      yearStart: "2024-04-06", yearEnd: "2025-04-05", monthOneEnd: "2024-05-05", personalAllowanceAnnual: "12570",
      rukBands: RUK_FROZEN, sctBands: sctBands("2306", "13991"),
      nicAnnual: nicThresholds("6396", "12570", "9100", "50270"), nicWeekly: nicThresholds("123", "242", "175", "967"),
      nicMonthly: nicThresholds("533", "1048", "758", "4189"),
      nicEmployeeMainRate: "0.08", nicEmployeeUpperRate: "0.02", nicEmployerRate: "0.138",
      employmentAllowanceAnnual: "5000", aeTriggerAnnual: "10000", aeQualifyingBandLower: "6240", aeQualifyingBandUpper: "50270",
    },
    taper: ["100000", "125140"], sctGrossTops: ["14876", "26561", "43662", "75000"] },
  { year: 2025, module: rates2025 as Record<string, unknown>,
    citation: "HMRC Rates and thresholds for employers 2025 to 2026; scottish-income-tax; income-tax-rates (June 2025); DWP AE review 2025/26",
    tables: {
      yearStart: "2025-04-06", yearEnd: "2026-04-05", monthOneEnd: "2025-05-05", personalAllowanceAnnual: "12570",
      rukBands: RUK_FROZEN, sctBands: sctBands("2827", "14921"),
      nicAnnual: nicThresholds("6500", "12570", "5000", "50270"), nicWeekly: nicThresholds("125", "242", "96", "967"),
      nicMonthly: nicThresholds("542", "1048", "417", "4189"),
      nicEmployeeMainRate: "0.08", nicEmployeeUpperRate: "0.02", nicEmployerRate: "0.15",
      employmentAllowanceAnnual: "10500", aeTriggerAnnual: "10000", aeQualifyingBandLower: "6240", aeQualifyingBandUpper: "50270",
    },
    taper: ["100000", "125140"], sctGrossTops: ["15397", "27491", "43662", "75000"] },
] as const;

for (const { year, module, citation, tables: expected, taper, sctGrossTops } of TRANSCRIPTIONS) {
  test(`${year} tables are transcribed from HMRC's published figures`, () => {
    const unfilled = unfilledPaths(module);
    assert.deepEqual(unfilled, [], `transcribe every ${year} figure (${citation}) — still unfilled: ${unfilled.join(", ")}`);
    const tables = gbTablesForTaxYear(year);
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, tables[key as keyof GbYearTables]]));
    assert.deepEqual(actual, expected, `${year}: ${citation}`);
    // Weekly/monthly NIC is HMRC's published rounding, never annual ÷ 52 or ÷ 12.
    assert.deepEqual(
      [gbNicThresholdsForPeriod(52, tables), gbNicThresholdsForPeriod(12, tables), gbNicThresholdsForPeriod(1, tables)],
      [expected.nicWeekly, expected.nicMonthly, expected.nicAnnual], `${year}: NIC thresholds by period`);
    assert.deepEqual([module[`GB_${year}_TAPER_START`], module[`GB_${year}_PERSONAL_ALLOWANCE_ZERO_AT`]], taper,
      `${year}: Personal Allowance taper (${citation})`);
    // scottish-income-tax prints gross-space tops: each is exactly the £12,570 allowance above the taxable-space top.
    sctGrossTops.forEach((top, index) =>
      assert.equal(add(tables.sctBands[index]!.upTo ?? "0", "12570"), fromUnits(toUnits(top)), `${year} SCT gross top ${index}`));
    for (const region of [null, "SCT"]) {
      assert.ok(GB_TAX_YEARS.editions.some((edition) => edition.year === year && (edition.region ?? null) === region),
        `${year} ${region ?? "main"} edition is declared`);
    }
  });
}

test("pay dates resolve to their own fiscal year's tables", () => {
  for (const [payDate, year] of [
    ["2026-04-06", 2026], ["2026-12-25", 2026], ["2027-04-05", 2026], ["2025-04-06", 2025], ["2025-09-20", 2025],
    ["2026-04-05", 2025], ["2024-04-06", 2024], ["2024-09-20", 2024], ["2025-03-20", 2024], ["2025-04-05", 2024],
  ] as const) assert.equal(gbResolveTaxYear(payDate), year, payDate);
});

test("tax month and week numbers follow HMRC's charts in every year", () => {
  for (const [payDate, month] of [
    ["2024-04-06", 1], ["2025-04-05", 12], ["2025-04-06", 1], ["2026-04-05", 12],
    ["2026-04-06", 1], ["2026-05-05", 1], ["2026-05-06", 2], ["2027-04-05", 12],
  ] as const) assert.equal(gbTaxMonthNumber(payDate), month, payDate);
  for (const [payDate, yearStart, week] of [
    ["2024-04-06", "2024-04-06", 1], ["2024-04-12", "2024-04-06", 1], ["2024-04-13", "2024-04-06", 2],
    ["2025-04-06", "2025-04-06", 1], ["2025-04-12", "2025-04-06", 1], ["2025-04-13", "2025-04-06", 2],
    ["2026-04-06", undefined, 1], ["2026-04-12", undefined, 1], ["2026-04-13", undefined, 2], ["2027-04-05", undefined, 53],
  ] as const) assert.equal(gbTaxWeekNumber(payDate, yearStart), week, payDate);
});

test("2026/27 NIC thresholds are published for 52/12/1 and pro-rated otherwise", () => {
  assert.deepEqual(gbNicThresholdsForPeriod(52), nicThresholds("129", "242", "96", "967"));
  assert.deepEqual(gbNicThresholdsForPeriod(12), nicThresholds("559", "1048", "417", "4189"));
  assert.deepEqual(gbNicThresholdsForPeriod(1), nicThresholds("6708", "12570", "5000", "50270"));
  // Fortnightly PT: 12,570 / 26 = 483.4615… → £483.46 (half down).
  assert.equal(gbNicThresholdsForPeriod(26).pt, "483.4600");
});

// ---------------------------------------------------------------------------
// Helper tables the goldens rely on
// ---------------------------------------------------------------------------

test("Cvalues match HMRC Tax Tables B-D Column 1 (ceiled, not rounded)", () => {
  // April 2023 print p.4; 37,700 × 2/12 = 6,283.33 prints 6,284. Cvalues choose
  // the formula; tax prices through the exact thresholds (§2.5).
  for (const [annual, periods, elapsed, pounds] of [
    ["37700", 12, 1, 3_142n], ["37700", 12, 2, 6_284n], ["37700", 12, 12, 37_700n], ["37700", 52, 1, 725n],
    ["125140", 12, 1, 10_429n], ["125140", 52, 1, 2_407n],
  ] as const) assert.equal(gbCvalueUnits(annual, periods, elapsed), pounds * 10_000n, `${annual}/${periods} period ${elapsed}`);
});

test("Tables-A values follow the §4.3.1 decomposition", () => {
  // 1257 = 2 × 500 + 257: ceiling(2,579/12) + 2 × £416.67 = £1,048.26 a month.
  // Manual Example 3 (p.4): 431L at week 11 = 11 × ceiling(4,319/52) = £913.66.
  for (const [code, periods, elapsed, kind, units] of [
    [1257n, 12, 1, "free", 104_826_00n], [1257n, 52, 1, "free", 24_192_00n], [1257n, 12, 3, "free", 3n * 104_826_00n],
    [475n, 12, 1, "additional", 39_584_00n],
    [18_014_398_509_482n * 500n + 1n, 12, 1, "additional", 18_014_398_509_482n * 4_166_700n + 8_400n],
    [431n, 52, 11, "free", 91_366_00n],
  ] as const) assert.equal(gbTablesAValueUnits(code, periods, elapsed, kind), units, `${code} ${periods}/${elapsed}`);
});

test("penny rounding disregards a half-penny or less (Regulation 12(1))", () => {
  for (const [units, rounded] of [[49n, 0n], [50n, 0n], [51n, 100n]] as const) {
    assert.equal(gbRoundPennyUnits(units), rounded, `${units}`);
  }
});

// ---------------------------------------------------------------------------
// Monotonicity sweeps
// ---------------------------------------------------------------------------

test("sweep: 2026/27 PAYE and NIC never decrease as pay rises, 0 to £20,000 monthly", () => {
  const code = parseGbTaxCode("1257L W1");
  let last = { tax: 0n, employee: 0n, employer: 0n };
  let lastTax = "";
  for (let pence = 0; pence <= 2_000_000; pence += 25_000) {
    const pay = (pence / 100).toFixed(2);
    const { tax } = calculateGbPaye({
      code, payDate: "2026-07-06", periodsPerYear: 12, periodPay: pay, priorTaxablePay: "0",
      priorAddedPay: "0", priorTaxPaid: "0", periodGrossPay: pay,
    });
    const { employee, employer } = calculateGbNic({ earnings: pay, periodsPerYear: 12 });
    const next = { tax: toUnits(tax), employee: toUnits(employee), employer: toUnits(employer) };
    for (const key of ["tax", "employee", "employer"] as const) assert.ok(next[key] >= last[key], `${key} fell at £${pay}`);
    last = next;
    lastTax = tax;
  }
  // Top of the sweep: Formula 3 on £10,428.3333 / £3,543.00 + (18,951 − 10,428.3333) × 45%, floored.
  assert.equal(lastTax, "7378.2000");
});

test("sweep: prior-year Scottish liability never decreases, 0 to £200,000", () => {
  for (const year of [2024, 2025]) {
    const tables = gbTablesForTaxYear(year);
    let previous = 0n;
    for (let pay = 0; pay <= 2_000_000_000; pay += 500_000) {
      const liability = gbSctLiabilityUnits(BigInt(pay), tables);
      assert.ok(liability >= previous, `${year} monotone at ${pay}`);
      previous = liability;
    }
  }
});
