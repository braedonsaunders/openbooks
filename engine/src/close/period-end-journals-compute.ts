import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { add, isZero, neg, normalizeMoney, sum } from "../money/money.ts";
import { PNL_TYPES } from "../records/account-types.ts";

/**
 * Period-end journal arithmetic. Pure: balances in, balanced journals out.
 *
 * Income-statement closing zeroes every income-statement balance through the
 * year end into retained earnings — directly, or through the income summary
 * account and then into retained earnings. The optional balance-sheet closing
 * then zeroes every balance-sheet balance (including the retained earnings
 * the first journal produced), and the opening journal re-establishes the
 * same balances on the first day of the next year. Every line keeps the
 * dimensions the policy preserves, and each offset is booked per preserved
 * dimension combination, so a balancing segment stays balanced on its own.
 * Amounts are exact ledger decimals, debit-positive.
 */

export const PERIOD_END_JOURNAL_KINDS = [
  "income_statement",
  "income_summary",
  "balance_sheet",
  "opening",
] as const;
export type PeriodEndJournalKind = (typeof PERIOD_END_JOURNAL_KINDS)[number];

export interface PeriodEndDimensions {
  departmentId: string | null;
  classId: string | null;
  locationId: string | null;
  projectId: string | null;
  /** Custom segment assignments (key → value id), nulls removed. */
  extraDims: Record<string, string>;
}

export interface PeriodEndBalance {
  accountId: string;
  accountType: string;
  dimensions: PeriodEndDimensions;
  /** Signed functional-currency balance, debit-positive. */
  amount: string;
}

export interface PeriodEndPolicyTerms {
  closingMethod: "retained_earnings" | "income_summary";
  retainedEarningsAccountId: string;
  incomeSummaryAccountId: string | null;
  balanceSheetJournals: boolean;
}

export interface PeriodEndLine {
  accountId: string;
  dimensions: PeriodEndDimensions;
  /** Signed amount, debit-positive. */
  amount: string;
}

export interface PeriodEndJournalPlan {
  kind: PeriodEndJournalKind;
  lines: PeriodEndLine[];
}

export interface PeriodEndPlan {
  journals: PeriodEndJournalPlan[];
  /** Earnings closed into retained earnings, credit-positive (a profit is positive). */
  closedEarnings: string;
}

export class PeriodEndComputationError extends Error {
  readonly name = "PeriodEndComputationError";
}

const PNL = new Set(PNL_TYPES);

export function isIncomeStatementType(accountType: string): boolean {
  return PNL.has(accountType);
}

function sortedExtraDims(extraDims: Record<string, string>): [string, string][] {
  return Object.entries(extraDims)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Stable identity of a dimension combination. */
export function dimensionKey(dimensions: PeriodEndDimensions): string {
  return JSON.stringify([
    dimensions.departmentId,
    dimensions.classId,
    dimensions.locationId,
    dimensions.projectId,
    sortedExtraDims(dimensions.extraDims),
  ]);
}

function normalizedDimensions(dimensions: PeriodEndDimensions): PeriodEndDimensions {
  return {
    departmentId: dimensions.departmentId ?? null,
    classId: dimensions.classId ?? null,
    locationId: dimensions.locationId ?? null,
    projectId: dimensions.projectId ?? null,
    extraDims: Object.fromEntries(sortedExtraDims(dimensions.extraDims ?? {})),
  };
}

function lineKey(accountId: string, dimensions: PeriodEndDimensions): string {
  return `${accountId}|${dimensionKey(dimensions)}`;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Net balances by account and dimension combination, zero groups removed, in a deterministic order. */
function netByAccount(
  balances: readonly { accountId: string; dimensions: PeriodEndDimensions; amount: string }[],
): PeriodEndLine[] {
  const groups = new Map<string, PeriodEndLine>();
  for (const balance of balances) {
    const dimensions = normalizedDimensions(balance.dimensions);
    const key = lineKey(balance.accountId, dimensions);
    const existing = groups.get(key);
    groups.set(key, {
      accountId: balance.accountId,
      dimensions,
      amount: existing ? add(existing.amount, balance.amount) : normalizeMoney(balance.amount),
    });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([, line]) => line)
    .filter((line) => !isZero(line.amount));
}

/** Sum of the given lines per dimension combination, in a deterministic order. */
function totalsByDimensions(
  lines: readonly PeriodEndLine[],
): { dimensions: PeriodEndDimensions; amount: string }[] {
  const totals = new Map<string, { dimensions: PeriodEndDimensions; amount: string }>();
  for (const line of lines) {
    const key = dimensionKey(line.dimensions);
    const existing = totals.get(key);
    totals.set(key, {
      dimensions: line.dimensions,
      amount: existing ? add(existing.amount, line.amount) : line.amount,
    });
  }
  return [...totals.entries()].sort(([a], [b]) => compareKeys(a, b)).map(([, total]) => total);
}

function assertBalanced(kind: PeriodEndJournalKind, lines: readonly PeriodEndLine[]): void {
  if (!isZero(sum(lines.map((line) => line.amount)))) {
    throw new PeriodEndComputationError(`the ${kind.replace("_", " ")} journal does not balance`);
  }
}

/**
 * The journals one legal entity's fiscal year needs. `incomeStatement` and
 * `balanceSheet` are cumulative balances through the year end on the
 * period-end basis (every posted and reversed entry assigned to a period
 * ending on or before it), grouped by the preserved dimensions.
 */
export function computePeriodEndJournals(input: {
  incomeStatement: readonly PeriodEndBalance[];
  balanceSheet: readonly PeriodEndBalance[];
  policy: PeriodEndPolicyTerms;
}): PeriodEndPlan {
  const { policy } = input;
  if (policy.closingMethod === "income_summary" && !policy.incomeSummaryAccountId) {
    throw new PeriodEndComputationError(
      "the income summary closing method needs an income summary account",
    );
  }
  for (const balance of input.incomeStatement) {
    if (!isIncomeStatementType(balance.accountType)) {
      throw new PeriodEndComputationError(
        `account ${balance.accountId} is not an income-statement account`,
      );
    }
  }
  for (const balance of input.balanceSheet) {
    if (isIncomeStatementType(balance.accountType)) {
      throw new PeriodEndComputationError(
        `account ${balance.accountId} is not a balance-sheet account`,
      );
    }
  }

  const journals: PeriodEndJournalPlan[] = [];
  const incomeBalances = netByAccount(input.incomeStatement);
  const closedEarnings = neg(sum(incomeBalances.map((line) => line.amount)));
  const offsetAccount =
    policy.closingMethod === "income_summary"
      ? policy.incomeSummaryAccountId!
      : policy.retainedEarningsAccountId;

  // Each income-statement balance is reversed; its dimension combination's
  // total lands on the offset account in that same combination.
  const closingLines: PeriodEndLine[] = incomeBalances.map((line) => ({
    accountId: line.accountId,
    dimensions: line.dimensions,
    amount: neg(line.amount),
  }));
  const offsets = totalsByDimensions(incomeBalances).filter((total) => !isZero(total.amount));
  const incomeStatementJournal = [
    ...closingLines,
    ...offsets.map((total) => ({
      accountId: offsetAccount,
      dimensions: total.dimensions,
      amount: total.amount,
    })),
  ];
  const equityEffects: PeriodEndLine[] = [];
  if (incomeStatementJournal.length > 0) {
    assertBalanced("income_statement", incomeStatementJournal);
    journals.push({ kind: "income_statement", lines: incomeStatementJournal });
    if (policy.closingMethod === "income_summary") {
      const summaryJournal = offsets.flatMap((total) => [
        {
          accountId: policy.incomeSummaryAccountId!,
          dimensions: total.dimensions,
          amount: neg(total.amount),
        },
        {
          accountId: policy.retainedEarningsAccountId,
          dimensions: total.dimensions,
          amount: total.amount,
        },
      ]);
      if (summaryJournal.length > 0) {
        assertBalanced("income_summary", summaryJournal);
        journals.push({ kind: "income_summary", lines: summaryJournal });
        equityEffects.push(...summaryJournal);
      }
    }
    equityEffects.push(
      ...offsets.map((total) => ({
        accountId: offsetAccount,
        dimensions: total.dimensions,
        amount: total.amount,
      })),
    );
  }

  if (policy.balanceSheetJournals) {
    // Balance-sheet balances after the income-statement closing: the posted
    // balances plus the equity the closing journals move.
    const closingBalances = netByAccount([...input.balanceSheet, ...equityEffects]);
    if (closingBalances.length > 0) {
      const balanceSheetJournal = closingBalances.map((line) => ({
        accountId: line.accountId,
        dimensions: line.dimensions,
        amount: neg(line.amount),
      }));
      if (!isZero(sum(balanceSheetJournal.map((line) => line.amount)))) {
        throw new PeriodEndComputationError(
          "balance-sheet balances do not net to zero after the income-statement closing; the ledger for this legal entity is out of balance through the year end",
        );
      }
      journals.push({ kind: "balance_sheet", lines: balanceSheetJournal });
      journals.push({ kind: "opening", lines: closingBalances.map((line) => ({ ...line })) });
    }
  }

  return { journals, closedEarnings };
}

/** Content identity of a plan: two generations with the same hash post the same journals. */
export function periodEndPlanHash(
  plan: Pick<PeriodEndPlan, "journals">,
  context: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        context,
        journals: plan.journals.map((journal) => ({
          kind: journal.kind,
          lines: journal.lines.map((line) => ({
            accountId: line.accountId,
            dimensions: {
              ...line.dimensions,
              extraDims: Object.fromEntries(sortedExtraDims(line.dimensions.extraDims)),
            },
            amount: normalizeMoney(line.amount),
          })),
        })),
      }),
    )
    .digest("hex");
}
