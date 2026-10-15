import { sql } from "drizzle-orm";

/**
 * Shared contracts for period-end FX revaluation and its recorded closing
 * rate evidence. This module sits below both: the revaluation engine prices
 * positions with it, and the evidence service validates recorded positions
 * against the same monetary-account definition, so a rate can never be
 * recorded for a position the engine would not revalue (or refused for one
 * it would).
 */

/**
 * The monetary-item predicate (IAS 21.8/16) over an `accounts` row aliased
 * `a`: bank, receivable, and payable types by default, plus any balance-sheet
 * account explicitly flagged `accounts.monetary = true`, minus any account
 * flagged `monetary = false`. ONE definition: the revaluation engine's
 * position loader, the close readiness check, and the closing-rate evidence
 * guard all consume it.
 */
export const MONETARY_ACCOUNT_SQL = sql`case
  when a.monetary is false then false
  when a.monetary is true then a.type not in
    ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred', 'equity')
  else a.type in ('asset_bank', 'asset_receivable', 'liability_payable')
end`;

/** The full recorded quote selected for a position, retained in audit. */
export interface RevaluationRateEvidenceQuote {
  id: string;
  version: number;
  rate: string;
  source: string;
  reason: string;
  rateDate: string;
  measurementCurrency: string;
  createdAt: string;
  createdBy: string;
}

/** One foreign-currency monetary exposure for a single legal entity. */
export interface RevaluationPosition {
  accountId: string;
  /** The foreign (transaction) currency, always ≠ the book's measurement currency. */
  currency: string;
  /** Base-currency carrying value on the books at historical rates (SUM of line.amount). */
  carryingBase: string;
  /** Foreign-currency balance still on the books (SUM of line.txn_amount). */
  foreignBalance: string;
  /** Period-end spot rate, foreign → measurement currency. */
  periodEndRate: string;
  /** The recorded closing quote this rate came from, when one is recorded. */
  rateEvidence?: RevaluationRateEvidenceQuote | null;
}

export interface RevaluationLine {
  accountId: string;
  /** Signed base-currency amount: positive = debit, negative = credit. */
  amount: string;
}
