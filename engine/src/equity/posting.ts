/**
 * Equity journal entries: the effective-dated account policy, balanced
 * entries posted through the journal kernel with origin `equity`, and the
 * governed reversal that corrects them.
 *
 * Every entry posts in the organization's primary book, in the legal
 * entity's functional currency, into the period covering its date, with an
 * exactly-once idempotency key: a retried command returns the entry it
 * already posted instead of posting twice. Closed periods, inactive
 * accounts and other ledger refusals reach the operator with their remedy.
 */
import { sql } from "drizzle-orm";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { fromUnits } from "../money/money.ts";
import { CloseError } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { EQUITY_ACCOUNTS_REMEDY, EquityError } from "./errors.ts";

export const EQUITY_JOURNAL_ORIGIN = "equity";

export interface EquityAccountPolicy {
  id: string;
  effectiveFrom: string;
  commonStockAccountId: string;
  preferredStockAccountId: string;
  apicAccountId: string;
  apicShareBasedAccountId: string;
  compensationExpenseAccountId: string;
  treasuryStockAccountId: string;
  convertibleInstrumentsAccountId: string;
}

/** The policy version in force on `on` for the legal entity; none refuses with the remedy. */
export async function resolveAccountPolicy(runner: SqlExecutor, orgId: string, subsidiaryId: string, on: string): Promise<EquityAccountPolicy> {
  const row = (await runner.execute<{
    id: string; effective_from: string; common_stock_account_id: string; preferred_stock_account_id: string; apic_account_id: string;
    apic_share_based_account_id: string; compensation_expense_account_id: string; treasury_stock_account_id: string; convertible_instruments_account_id: string;
  }>(sql`
    select id, effective_from::text as effective_from, common_stock_account_id, preferred_stock_account_id, apic_account_id,
           apic_share_based_account_id, compensation_expense_account_id, treasury_stock_account_id, convertible_instruments_account_id
      from equity_account_policies
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and effective_from <= ${on}::date
     order by effective_from desc
     limit 1`)).rows[0];
  if (!row) {
    throw new EquityError(`No equity account policy is in force for this legal entity on ${on}.`, {
      code: "equity_account_policy_missing",
      remedy: EQUITY_ACCOUNTS_REMEDY,
    });
  }
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    commonStockAccountId: row.common_stock_account_id,
    preferredStockAccountId: row.preferred_stock_account_id,
    apicAccountId: row.apic_account_id,
    apicShareBasedAccountId: row.apic_share_based_account_id,
    compensationExpenseAccountId: row.compensation_expense_account_id,
    treasuryStockAccountId: row.treasury_stock_account_id,
    convertibleInstrumentsAccountId: row.convertible_instruments_account_id,
  };
}

/** Accounts a consideration (cash received or paid) may settle through. */
export const CONSIDERATION_ACCOUNT_TYPES = ["asset_bank", "asset_current_other"] as const;

/** A consideration account must be an active posting bank or current-asset account of the organization. */
export async function requireConsiderationAccount(runner: SqlExecutor, orgId: string, accountId: string | null | undefined): Promise<string> {
  if (!accountId) {
    throw new EquityError("Choose the account the consideration settles through.", {
      code: "equity_consideration_account_missing",
      remedy: "Choose the bank or current-asset account that received or paid the cash.",
      field: "considerationAccountId",
    });
  }
  const row = (await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`)).rows[0];
  if (!row || !row.is_active || row.is_summary || !(CONSIDERATION_ACCOUNT_TYPES as readonly string[]).includes(row.type)) {
    throw new EquityError("The consideration account must be an active bank or current-asset posting account.", {
      code: "equity_consideration_account_invalid",
      remedy: "Choose an active bank or current-asset account.",
      field: "considerationAccountId",
    });
  }
  return accountId;
}

export interface EquityLeg {
  accountId: string;
  /** Signed ledger units: positive debits, negative credits. */
  units: bigint;
  memo?: string;
}

function refusal(error: unknown, what: string): never {
  if (error instanceof PostingError || error instanceof CloseError) {
    throw new EquityError(`The ${what} was refused by the ledger: ${error.message}`, {
      status: 422,
      code: "equity_posting_refused",
      remedy: "Resolve the ledger refusal (for example, reopen the period through Period Close or reactivate the account), then try again.",
      cause: error,
    });
  }
  throw error;
}

async function primaryBook(runner: SqlExecutor, orgId: string): Promise<string> {
  const book = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 for share`)).rows[0];
  if (!book) {
    throw new EquityError("The organization has no active primary book that posts to the general ledger.", {
      code: "equity_book_missing",
      remedy: "Activate the primary accounting book in Company Settings → Accounting books.",
    });
  }
  return book.id;
}

async function coveringPeriod(runner: SqlExecutor, orgId: string, subsidiaryId: string, on: string): Promise<string> {
  const period = await resolveCoveringPeriod(runner, orgId, on, subsidiaryId);
  if (!period) {
    throw new EquityError(`No accounting period covers ${on}.`, {
      code: "equity_period_missing",
      remedy: `Generate the accounting period covering ${on} (Accounting → Period Close), then try again.`,
    });
  }
  return period.id;
}

/**
 * Post one balanced equity entry. Zero legs are dropped; an entry whose legs
 * do not balance is a defect in the caller and refuses before the kernel.
 */
export async function postEquityEntry(
  runner: SqlExecutor,
  input: {
    orgId: string;
    subsidiaryId: string;
    currency: string;
    postingDate: string;
    entryNumberBase: string;
    memo: string;
    idempotencyKey: string;
    actorId: string | null;
    auditAction: string;
    auditChanges: Record<string, unknown>;
    legs: readonly EquityLeg[];
  },
): Promise<string> {
  const legs = input.legs.filter((leg) => leg.units !== 0n);
  const balance = legs.reduce((sum, leg) => sum + leg.units, 0n);
  if (legs.length < 2 || balance !== 0n) {
    throw new EquityError(`The ${input.memo} entry does not balance.`, { status: 409, code: "equity_entry_unbalanced", remedy: "Review the amounts and try again." });
  }
  const bookId = await primaryBook(runner, input.orgId);
  const periodId = await coveringPeriod(runner, input.orgId, input.subsidiaryId, input.postingDate);
  try {
    const posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      entryNumber: await nextFreeEntryNumber(runner, input.orgId, input.entryNumberBase),
      postingDate: input.postingDate,
      periodId,
      memo: input.memo,
      origin: EQUITY_JOURNAL_ORIGIN,
      idempotencyKey: input.idempotencyKey,
      currency: input.currency,
      actorId: input.actorId,
      auditAction: input.auditAction,
      auditChanges: input.auditChanges,
      lines: legs.map((leg) => ({ accountId: leg.accountId, amount: fromUnits(leg.units), currency: input.currency, memo: leg.memo ?? input.memo })),
    });
    return posted.entryId;
  } catch (error) {
    return refusal(error, `${input.memo} entry`);
  }
}

/**
 * Reverse a posted equity entry on `reversalDate`: a new entry mirrors every
 * line with the opposite sign and links the original, which is then marked
 * reversed. The original is never edited.
 */
export async function reverseEquityEntry(
  runner: SqlExecutor,
  input: { orgId: string; entryId: string; reversalDate: string; memo: string; idempotencyKey: string; actorId: string | null; auditChanges: Record<string, unknown> },
): Promise<string> {
  const header = (await runner.execute<{ subsidiary_id: string; entry_number: string; origin: string; status: string }>(sql`
    select subsidiary_id, entry_number, origin, status from journal_entries
     where org_id = ${input.orgId} and id = ${input.entryId}
     for update`)).rows[0];
  if (!header || header.origin !== EQUITY_JOURNAL_ORIGIN) {
    throw new EquityError("The entry to reverse is not an equity entry of this organization.", { status: 409, code: "equity_entry_unknown", remedy: "Reload the record and try again." });
  }
  // Live entries only: an entry already reversed cannot be reversed again.
  if (header.status !== "posted") {
    throw new EquityError(`Entry ${header.entry_number} is not a posted entry and cannot be reversed.`, { status: 409, code: "equity_entry_not_posted", remedy: "Reload the record; it may already be reversed." });
  }
  const lines = (await runner.execute<{ account_id: string; amount: string; currency: string; txn_amount: string; fx_rate: string; line_number: number }>(sql`
    select account_id, amount::text as amount, currency, txn_amount::text as txn_amount, fx_rate::text as fx_rate, line_number
      from journal_lines where org_id = ${input.orgId} and entry_id = ${input.entryId}
     order by line_number`)).rows;
  const bookId = await primaryBook(runner, input.orgId);
  const periodId = await coveringPeriod(runner, input.orgId, header.subsidiary_id, input.reversalDate);
  try {
    const posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId,
      subsidiaryId: header.subsidiary_id,
      entryNumber: await nextFreeEntryNumber(runner, input.orgId, `${header.entry_number}-REV`),
      postingDate: input.reversalDate,
      periodId,
      memo: input.memo,
      origin: EQUITY_JOURNAL_ORIGIN,
      reversesEntryId: input.entryId,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      auditAction: "equity.reverse",
      auditChanges: input.auditChanges,
      lines: lines.map((line) => ({
        accountId: line.account_id,
        amount: negate(line.amount),
        currency: line.currency,
        txnAmount: negate(line.txn_amount),
        fxRate: line.fx_rate,
        memo: input.memo,
      })),
    });
    await markEntryReversed(runner, { orgId: input.orgId, entryId: input.entryId, actorId: input.actorId });
    return posted.entryId;
  } catch (error) {
    return refusal(error, "reversal");
  }
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount === "0" || /^0(\.0+)?$/.test(amount) ? amount : `-${amount}`;
}
