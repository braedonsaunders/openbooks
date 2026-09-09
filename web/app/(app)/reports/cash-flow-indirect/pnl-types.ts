/**
 * Account types that make up profit and loss.
 *
 * Extracted from the page so the loader and the native render share one
 * definition rather than two copies that could drift.
 */
export const PNL_TYPES = [
  'income',
  'income_other',
  'cogs',
  'expense',
  'expense_other',
  'expense_deferred',
]
