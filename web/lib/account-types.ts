/**
 * Canonical account-type universes (F-u1-001 / P2: one definition).
 *
 * The formal P&L universe is six account types. Slices of the P&L — by
 * segment, project, or anything else — must filter on exactly these lists,
 * so the slices always sum to the headline P&L. Never hand-write a type
 * list that means "the P&L" or "P&L costs" anywhere else: an omitted type
 * silently understates the slice while the headline still includes it
 * (expense_other vanished from two analytics breakdowns exactly this way).
 *
 * Deliberately narrower lists live with their owners and are NOT this:
 * operating expenses (OPERATING_EXPENSE_TYPES in analytics/operating-expenses,
 * which excludes cogs and expense_other by doctrine), revenue pairs, and
 * sign-flip pairs are different business rules, not subsets to merge here.
 *
 * This module has no imports, so readers, tests, and (later) client code can
 * share the definition without dragging in a query engine.
 */
export const PNL_TYPES = ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"];

/**
 * Cost side of the P&L universe: every PNL_TYPES member that is not revenue.
 * The partition is revenue (income, income_other) vs costs (below).
 */
export const PNL_COST_TYPES = ["cogs", "expense", "expense_other", "expense_deferred"];

/** Balance-sheet asset types the CoA class and the statement engine share. */
export const ASSET_TYPES = ["asset_bank", "asset_receivable", "asset_current_other", "asset_fixed", "asset_other"];
export const LIABILITY_TYPES = [
  "liability_payable",
  "liability_card",
  "liability_current_other",
  "liability_long_term",
];
export const EQUITY_TYPES = ["equity"];

/**
 * Chart-of-accounts statement classes → the account types each class owns.
 * The CoA hierarchy headers and a class-total GL drill must use this map, not
 * a second handwritten list that can omit a type the balance roll-up includes.
 */
export const ACCOUNT_CLASS_TYPES: Record<string, readonly string[]> = {
  asset: ASSET_TYPES,
  liability: LIABILITY_TYPES,
  equity: EQUITY_TYPES,
  income: ["income", "income_other"],
  expense: PNL_COST_TYPES,
};
