import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { add, neg, sum } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import type { Line } from "./run-stub-records.ts";

/**
 * Where the credit side of a non-cash earning may post. A prepaid asset
 * (the benefit was paid for in advance), a provider clearing liability (a
 * premium owed to an insurer or plan) or a contra-expense account (a benefit
 * whose cost the employer already expensed elsewhere, such as personal use
 * of a company vehicle, so the payroll entry nets to nothing).
 */
const NON_CASH_OFFSET_ACCOUNT_TYPES = new Set([
  "asset_current_other", "asset_other", "liability_current_other", "liability_long_term",
  "cogs", "expense", "expense_other",
]);
const CONTRA_EXPENSE_TYPES = new Set(["cogs", "expense", "expense_other"]);

/**
 * Why a non-cash earning's offset account cannot be used, or null. A
 * contra-expense offset must differ from the earning's expense account:
 * posting both sides to one account would record nothing.
 */
export function nonCashOffsetProblem(offset: { id: string; type: string } | undefined, expenseAccountId: string | null): string | null {
  if (!offset || !NON_CASH_OFFSET_ACCOUNT_TYPES.has(offset.type)) {
    return "the non-cash offset account must be an active posting prepaid asset, a provider clearing liability, or a contra-expense account";
  }
  if (CONTRA_EXPENSE_TYPES.has(offset.type) && expenseAccountId !== null && offset.id === expenseAccountId) {
    return "a contra-expense offset must be a different account from the earning's expense account — posting both sides to one account records nothing";
  }
  return null;
}

/** Earnings paid by another instrument are reported and taxed by the same pack as wages. */
export function nonCashEarnings(lines: readonly Pick<Line, "kind" | "amount" | "paymentKind" | "accrualOnly">[]): string {
  return sum(lines.filter((line) => line.kind === "earning" && !line.accrualOnly && line.paymentKind === "non_cash").map((line) => line.amount));
}

export function cashGrossEarnings(gross: string, lines: readonly Pick<Line, "kind" | "amount" | "paymentKind" | "accrualOnly">[]): string {
  return add(gross, neg(nonCashEarnings(lines)));
}

/**
 * Stamp every earning path, including assignments, derived earnings and run
 * adjustments. The statutory flags remain on the earning unchanged; this
 * stamp describes its cash and accounting representation only.
 */
export async function applyEarningPaymentKinds(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; subsidiaryId: string | null; currency: string;
    components: readonly Record<string, unknown>[]; lines: Line[];
    wageExpenseAccountId: string | null;
  },
): Promise<void> {
  const components = new Map(args.components.map((component) => [String(component.id), component]));
  const checked = new Set<string>();
  for (const line of args.lines) {
    const component = line.componentId === null ? undefined : components.get(line.componentId);
    if (component?.payment_kind !== "non_cash") continue;
    if (line.kind !== "earning" || component.kind !== "earning" || component.system_key != null || component.non_cash_account_id == null) {
      throw new PayrollError(`component "${String(component.name)}" has an invalid non-cash representation — use a user earning component with a prepaid or provider clearing account`);
    }
    const accountId = String(component.non_cash_account_id);
    if (!checked.has(accountId)) {
      const account = (await tx.execute<{ type: string; currency_restriction: string | null; in_scope: boolean }>(sql`
        with recursive ancestors as (
          select id, parent_id from subsidiaries where org_id = ${args.orgId} and id = ${args.subsidiaryId}
          union all
          select s.id, s.parent_id from subsidiaries s join ancestors a on s.id = a.parent_id where s.org_id = ${args.orgId}
        )
        select a.type, a.currency_restriction,
               (a.subsidiary_id is null or a.subsidiary_id = ${args.subsidiaryId}
                or (a.subsidiary_include_children and a.subsidiary_id in (select id from ancestors))) as in_scope
          from accounts a where a.org_id = ${args.orgId} and a.id = ${accountId} and a.is_active and not a.is_summary
      `)).rows[0];
      const expenseAccountId = component.expense_account_id ?? args.wageExpenseAccountId;
      const problem = nonCashOffsetProblem(account ? { id: accountId, type: account.type } : undefined, expenseAccountId == null ? null : String(expenseAccountId));
      if (problem) {
        throw new PayrollError(`non-cash component "${String(component.name)}": ${problem} — configure its non-cash account in Payroll components`);
      }
      if (!account.in_scope || (account.currency_restriction !== null && account.currency_restriction !== args.currency)) {
        throw new PayrollError(`non-cash component "${String(component.name)}" has a clearing account outside the pay run's entity or currency — select an account available to this entity and ${args.currency}`);
      }
      checked.add(accountId);
    }
    line.paymentKind = "non_cash";
    line.nonCashAccountId = accountId;
    if (!line.expenseAccountId) {
      const expenseAccountId = component.expense_account_id ?? args.wageExpenseAccountId;
      if (!expenseAccountId) throw new PayrollError(`non-cash component "${String(component.name)}" has no expense account — configure its expense or the payroll wage expense account before calculating`);
      line.expenseAccountId = String(expenseAccountId);
      line.expenseAccountSource = component.expense_account_id ? "component" : "org_default";
      line.expenseAccountEvidence = { reason: "Non-cash benefit expense at calculation", reference: `pay_components:${String(component.id)}` };
    }
  }
}
