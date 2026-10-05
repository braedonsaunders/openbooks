/**
 * Where the credit side of a non-cash earning may post. A prepaid asset
 * (the benefit was paid for in advance), a provider clearing liability (a
 * premium owed to an insurer or plan) or a contra-expense account (a benefit
 * whose cost the employer already expensed elsewhere, such as personal use
 * of a company vehicle, so the payroll entry nets to nothing).
 *
 * Kept free of imports so the setup picker can offer exactly the accounts
 * the posting guard accepts.
 */
export const NON_CASH_OFFSET_ACCOUNT_TYPES: readonly string[] = [
  "asset_current_other", "asset_other", "liability_current_other", "liability_long_term",
  "cogs", "expense", "expense_other",
];

export const NON_CASH_CONTRA_EXPENSE_TYPES: readonly string[] = ["cogs", "expense", "expense_other"];
