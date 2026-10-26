import { add, cmp, isZero, neg } from "../money/money.ts";
import { refuse } from "./asset-refusal.ts";

/**
 * Pure arithmetic for construction in progress. A CIP record's open balance
 * is every linked GL cost less every posted capitalization (assets and
 * expensed write-offs). Capitalization may take part of the balance, never
 * more than it, and posts one balanced entry crediting the CIP account.
 */

export interface CipCostAmount {
  amount: string;
  status: "linked" | "unlinked";
}

export interface CipCapitalizationAmount {
  capitalizedAmount: string;
  expensedAmount: string;
  status: "posted" | "reversed";
}

export function cipOpenBalance(
  costs: readonly CipCostAmount[],
  capitalizations: readonly CipCapitalizationAmount[],
): { linked: string; capitalized: string; expensed: string; open: string } {
  const linked = costs
    .filter((cost) => cost.status === "linked")
    .reduce((sum, cost) => add(sum, cost.amount), "0");
  const posted = capitalizations.filter((entry) => entry.status === "posted");
  const capitalized = posted.reduce((sum, entry) => add(sum, entry.capitalizedAmount), "0");
  const expensed = posted.reduce((sum, entry) => add(sum, entry.expensedAmount), "0");
  return { linked, capitalized, expensed, open: add(linked, neg(add(capitalized, expensed))) };
}

export type CapitalizationLineKind = "asset" | "component" | "expense";

export interface PlannedCapitalizationLine {
  kind: CapitalizationLineKind;
  amount: string;
}

/** Validate a capitalization against the open balance; partial capitalization is allowed. */
export function planCapitalization(
  openBalance: string,
  lines: readonly PlannedCapitalizationLine[],
): { capitalized: string; expensed: string; total: string; remaining: string } {
  if (lines.length === 0)
    refuse("capitalization_lines_required", "add at least one asset, component or expense line");
  let capitalized = "0.0000";
  let expensed = "0.0000";
  lines.forEach((line, index) => {
    if (cmp(line.amount, "0") <= 0)
      refuse("amount_not_positive", `line ${index + 1} amount must be greater than zero`);
    if (line.kind === "expense") expensed = add(expensed, line.amount);
    else capitalized = add(capitalized, line.amount);
  });
  const total = add(capitalized, expensed);
  if (cmp(total, openBalance) > 0) {
    refuse(
      "capitalization_exceeds_balance",
      `the capitalization totals ${total} but only ${add(openBalance, "0")} is open in construction in progress`,
      {
        remedy: "Link the remaining costs first, or reduce the amounts.",
      },
    );
  }
  return { capitalized, expensed, total, remaining: add(openBalance, neg(total)) };
}

/**
 * Debit each target (asset cost account or expense account) and credit the
 * CIP account for the total, all carrying the CIP record's dimensions.
 */
export function buildCapitalizationLines(
  cipAccountId: string,
  lines: readonly { targetAccountId: string; amount: string; memo: string }[],
  memo: string,
): { accountId: string; amount: string; memo: string }[] {
  const debits = lines.map((line) => ({
    accountId: line.targetAccountId,
    amount: add(line.amount, "0"),
    memo: line.memo,
  }));
  const total = debits.reduce((sum, line) => add(sum, line.amount), "0");
  if (isZero(total)) refuse("amount_not_positive", "nothing to capitalize");
  const out = [...debits, { accountId: cipAccountId, amount: neg(total), memo }];
  if (debits.some((line) => line.accountId === cipAccountId)) {
    refuse(
      "capitalization_target_is_cip",
      "a capitalization target cannot be the construction-in-progress account itself",
    );
  }
  return out;
}
