import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "../money/money.ts";
import {
  computePeriodEndJournals,
  dimensionKey,
  periodEndPlanHash,
  PeriodEndComputationError,
  type PeriodEndBalance,
  type PeriodEndDimensions,
  type PeriodEndLine,
  type PeriodEndPolicyTerms,
} from "./period-end-journals-compute.ts";

const NONE: PeriodEndDimensions = {
  departmentId: null,
  classId: null,
  locationId: null,
  projectId: null,
  extraDims: {},
};
const dims = (patch: Partial<PeriodEndDimensions>): PeriodEndDimensions => ({ ...NONE, ...patch });

const RE = "re-account";
const SUMMARY = "summary-account";
const direct: PeriodEndPolicyTerms = {
  closingMethod: "retained_earnings",
  retainedEarningsAccountId: RE,
  incomeSummaryAccountId: null,
  balanceSheetJournals: false,
};
const viaSummary: PeriodEndPolicyTerms = {
  closingMethod: "income_summary",
  retainedEarningsAccountId: RE,
  incomeSummaryAccountId: SUMMARY,
  balanceSheetJournals: false,
};

const balance = (
  accountId: string,
  accountType: string,
  amount: string,
  dimensions: PeriodEndDimensions = NONE,
): PeriodEndBalance => ({ accountId, accountType, amount, dimensions });

function net(lines: readonly PeriodEndLine[], accountId?: string): string {
  return sum(
    lines
      .filter((line) => accountId === undefined || line.accountId === accountId)
      .map((line) => line.amount),
  );
}

/** Revenue 1000.10 (credit), cost 400.05 and expense 99.99 (debits): profit 500.06. */
const incomeStatement: PeriodEndBalance[] = [
  balance("revenue", "income", "-1000.1000"),
  balance("cogs", "cogs", "400.0500"),
  balance("rent", "expense", "99.9900"),
];

test("direct closing zeroes every income-statement balance into retained earnings, balanced to the unit", () => {
  const plan = computePeriodEndJournals({ incomeStatement, balanceSheet: [], policy: direct });
  assert.equal(plan.journals.length, 1);
  const [closing] = plan.journals;
  assert.equal(closing!.kind, "income_statement");
  assert.equal(net(closing!.lines), "0.0000");
  for (const source of incomeStatement) {
    assert.equal(
      sum([source.amount, net(closing!.lines, source.accountId)]),
      "0.0000",
      `${source.accountId} closes to zero`,
    );
  }
  // A profit credits retained earnings; closed earnings are reported credit-positive.
  assert.equal(net(closing!.lines, RE), "-500.0600");
  assert.equal(plan.closedEarnings, "500.0600");
});

test("income summary closing passes through the summary account, which nets to zero across both journals", () => {
  const plan = computePeriodEndJournals({ incomeStatement, balanceSheet: [], policy: viaSummary });
  assert.deepEqual(
    plan.journals.map((journal) => journal.kind),
    ["income_statement", "income_summary"],
  );
  for (const journal of plan.journals)
    assert.equal(net(journal.lines), "0.0000", `${journal.kind} balances`);
  const all = plan.journals.flatMap((journal) => journal.lines);
  assert.equal(net(all, SUMMARY), "0.0000");
  assert.equal(net(all, RE), "-500.0600");
  assert.equal(
    net(plan.journals[0]!.lines, RE),
    "0.0000",
    "the first journal never touches retained earnings",
  );
});

test("a loss debits retained earnings", () => {
  const plan = computePeriodEndJournals({
    incomeStatement: [
      balance("revenue", "income", "-10.0000"),
      balance("rent", "expense", "35.5000"),
    ],
    balanceSheet: [],
    policy: direct,
  });
  assert.equal(net(plan.journals[0]!.lines, RE), "25.5000");
  assert.equal(plan.closedEarnings, "-25.5000");
});

test("preserved dimensions close per combination, so every combination and balancing segment value balances on its own", () => {
  const fundA = { fund: "fund-a" };
  const fundB = { fund: "fund-b" };
  const plan = computePeriodEndJournals({
    incomeStatement: [
      balance("revenue", "income", "-300.0000", dims({ departmentId: "sales", extraDims: fundA })),
      balance("revenue", "income", "-200.0000", dims({ departmentId: "ops", extraDims: fundB })),
      balance("rent", "expense", "120.0000", dims({ departmentId: "sales", extraDims: fundA })),
      balance("rent", "expense", "250.0000", dims({ departmentId: "ops", extraDims: fundB })),
    ],
    balanceSheet: [],
    policy: direct,
  });
  const lines = plan.journals[0]!.lines;
  const byCombination = new Map<string, string[]>();
  for (const line of lines) {
    const key = dimensionKey(line.dimensions);
    byCombination.set(key, [...(byCombination.get(key) ?? []), line.amount]);
  }
  assert.equal(byCombination.size, 2);
  for (const amounts of byCombination.values()) assert.equal(sum(amounts), "0.0000");
  const offsets = lines.filter((line) => line.accountId === RE);
  assert.deepEqual(
    offsets
      .map((line) => [line.dimensions.departmentId, line.dimensions.extraDims.fund, line.amount])
      .sort(),
    [
      ["ops", "fund-b", "50.0000"],
      ["sales", "fund-a", "-180.0000"],
    ],
  );
});

test("balance-sheet closing zeroes every balance-sheet account after the income-statement closing, and the opening restores it", () => {
  const balanceSheet: PeriodEndBalance[] = [
    balance("bank", "asset_bank", "1500.0600"),
    balance("payable", "liability_payable", "-700.0000"),
    balance("capital", "equity", "-300.0000"),
  ];
  const plan = computePeriodEndJournals({
    incomeStatement,
    balanceSheet,
    policy: { ...direct, balanceSheetJournals: true },
  });
  assert.deepEqual(
    plan.journals.map((journal) => journal.kind),
    ["income_statement", "balance_sheet", "opening"],
  );
  const closing = plan.journals[1]!;
  const opening = plan.journals[2]!;
  assert.equal(net(closing.lines), "0.0000");
  assert.equal(net(opening.lines), "0.0000");
  // Retained earnings carries the year's profit into the balance-sheet closing.
  assert.equal(net(closing.lines, RE), "500.0600");
  for (const account of ["bank", "payable", "capital", RE]) {
    assert.equal(
      sum([net(closing.lines, account), net(opening.lines, account)]),
      "0.0000",
      `${account} reopens exactly`,
    );
  }
  assert.equal(net(closing.lines, "bank"), "-1500.0600");
});

test("an out-of-balance ledger is refused rather than closed with a plug", () => {
  assert.throws(
    () =>
      computePeriodEndJournals({
        incomeStatement,
        balanceSheet: [balance("bank", "asset_bank", "1.0000")],
        policy: { ...direct, balanceSheetJournals: true },
      }),
    (error: unknown) =>
      error instanceof PeriodEndComputationError && /out of balance/.test(error.message),
  );
});

test("the plan and its hash are independent of input order and split balances", () => {
  const forward = computePeriodEndJournals({ incomeStatement, balanceSheet: [], policy: direct });
  const shuffled = computePeriodEndJournals({
    incomeStatement: [
      balance("rent", "expense", "50.0000"),
      incomeStatement[0]!,
      balance("rent", "expense", "49.9900"),
      incomeStatement[1]!,
    ],
    balanceSheet: [],
    policy: direct,
  });
  assert.deepEqual(shuffled, forward);
  assert.equal(
    periodEndPlanHash(shuffled, { year: 2026 }),
    periodEndPlanHash(forward, { year: 2026 }),
  );
  assert.notEqual(
    periodEndPlanHash(forward, { year: 2027 }),
    periodEndPlanHash(forward, { year: 2026 }),
  );
});

test("a year whose income statement already nets to zero per account posts nothing", () => {
  const plan = computePeriodEndJournals({
    incomeStatement: [
      balance("revenue", "income", "-10.0000"),
      balance("revenue", "income", "10.0000"),
    ],
    balanceSheet: [],
    policy: direct,
  });
  assert.deepEqual(plan.journals, []);
  assert.equal(plan.closedEarnings, "0.0000");
});

test("exact decimal arithmetic holds at ledger scale with many small balances", () => {
  const many = Array.from({ length: 1000 }, (_, index) =>
    balance(`expense-${String(index).padStart(4, "0")}`, "expense", "0.0001"),
  );
  const plan = computePeriodEndJournals({
    incomeStatement: [...many, balance("revenue", "income", "-999999999999.9999")],
    balanceSheet: [],
    policy: direct,
  });
  assert.equal(net(plan.journals[0]!.lines), "0.0000");
  assert.equal(plan.closedEarnings, "999999999999.8999");
});

test("misclassified balances and an income summary method without its account are refused", () => {
  assert.throws(
    () =>
      computePeriodEndJournals({
        incomeStatement: [balance("bank", "asset_bank", "1.0000")],
        balanceSheet: [],
        policy: direct,
      }),
    PeriodEndComputationError,
  );
  assert.throws(
    () =>
      computePeriodEndJournals({
        incomeStatement: [],
        balanceSheet: [balance("rent", "expense", "1.0000")],
        policy: direct,
      }),
    PeriodEndComputationError,
  );
  assert.throws(
    () =>
      computePeriodEndJournals({
        incomeStatement,
        balanceSheet: [],
        policy: { ...viaSummary, incomeSummaryAccountId: null },
      }),
    /income summary account/,
  );
});
