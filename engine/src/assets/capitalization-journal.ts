import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, isZero, neg } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  loadSubsidiaryContext,
  SubsidiaryError,
  uuidArray,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { assertAssetPeriodOpen, AssetLifecycleError } from "./asset-lifecycle.ts";
import { refuse } from "./asset-refusal.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";

/**
 * Reclassification journals for capitalization: moving a purchase from the
 * account it debited (a clearing, expense or construction-in-progress
 * account) to an asset's cost account, and moving construction in progress
 * into assets or expense. Every entry posts through the journal kernel in
 * the primary posting book with origin `asset_capitalization`, under an
 * idempotency key, after the assets module's period fence. Corrections are
 * mirror reversals, never edits.
 */

export const CAPITALIZATION_ORIGIN = "asset_capitalization";

export interface CapitalizationLine {
  accountId: string;
  amount: string;
  memo: string;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
}

async function primaryPostingBook(tx: SqlExecutor, orgId: string): Promise<string> {
  const book = (
    await tx.execute<{ id: string }>(
      sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share`,
      "objects",
    )
  )[0];
  if (!book) {
    refuse("primary_book_missing", "the organization has no active primary posting book", {
      remedy: "Mark one active accounting book as primary and posting in Setup → Accounting books.",
    });
  }
  return book.id;
}

async function openPeriodFor(
  tx: SqlExecutor,
  args: { orgId: string; bookId: string; subsidiaryId: string; date: string },
): Promise<string> {
  if (!isIsoCalendarDate(args.date))
    refuse("date_invalid", "the posting date must be a calendar date (YYYY-MM-DD)");
  const period = await resolveCoveringPeriod(tx, args.orgId, args.date, args.subsidiaryId);
  if (!period) {
    refuse("period_missing", `no single accounting period covers ${args.date}`, {
      remedy:
        "Create the accounting period in Setup → Fiscal calendars, or choose a date inside an existing period.",
    });
  }
  try {
    await assertAssetPeriodOpen(tx, {
      orgId: args.orgId,
      periodId: period.id,
      bookId: args.bookId,
      subsidiaryIds: [args.subsidiaryId],
    });
  } catch (error) {
    if (error instanceof AssetLifecycleError) {
      refuse("period_closed", error.message, {
        status: 409,
        remedy:
          "Choose a date in an open period, or reopen the period for the assets module in Close.",
      });
    }
    throw error;
  }
  return period.id;
}

async function assertPostableAccounts(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  lines: readonly CapitalizationLine[],
): Promise<void> {
  const ids = [...new Set(lines.map((line) => line.accountId))];
  const accounts = await tx.execute<{
    id: string;
    is_active: boolean;
    is_summary: boolean;
    number: string | null;
    name: string;
  }>(
    sql`
    select id, is_active, is_summary, number, name from accounts
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])
     for share`,
    "objects",
  );
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const id of ids) {
    const account = byId.get(id);
    if (!account)
      refuse("account_invalid", "a capitalization account does not exist in this organization");
    if (!account.is_active || account.is_summary) {
      refuse(
        "account_not_postable",
        `account ${[account.number, account.name].filter(Boolean).join(" ")} is inactive or a summary account`,
        {
          remedy: "Reactivate the account or point the asset category at a postable account.",
        },
      );
    }
  }
  try {
    await validateSubsidiaryRestrictions(tx, {
      orgId,
      ctx: await loadSubsidiaryContext(tx, orgId),
      docSubsidiaryId: subsidiaryId,
      lines: lines.map((line) => ({
        accountId: line.accountId,
        amount: line.amount,
        subsidiaryId,
        departmentId: line.departmentId ?? null,
        projectId: line.projectId ?? null,
        locationId: line.locationId ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof SubsidiaryError) refuse("subsidiary_restriction", error.message);
    throw error;
  }
}

/** Post one balanced capitalization entry; returns null when nothing moves. */
export async function postCapitalizationEntry(
  tx: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    subsidiaryId: string;
    date: string;
    entryNumber: string;
    memo: string;
    idempotencyKey: string;
    lines: readonly CapitalizationLine[];
  },
): Promise<{
  entryId: string;
  lines: { id: string; lineNumber: number; accountId: string; amount: string }[];
} | null> {
  const lines = args.lines.filter((line) => !isZero(line.amount));
  if (lines.length === 0) return null;
  const residual = lines.reduce((sum, line) => add(sum, line.amount), "0");
  if (!isZero(residual))
    refuse(
      "reclass_unbalanced",
      `the capitalization entry does not balance (residual ${residual})`,
    );
  const bookId = await primaryPostingBook(tx, args.orgId);
  const periodId = await openPeriodFor(tx, {
    orgId: args.orgId,
    bookId,
    subsidiaryId: args.subsidiaryId,
    date: args.date,
  });
  await assertPostableAccounts(tx, args.orgId, args.subsidiaryId, lines);
  const currency = (
    await tx.execute<{ base_currency: string }>(
      sql`
    select base_currency from subsidiaries where org_id = ${args.orgId} and id = ${args.subsidiaryId}`,
      "objects",
    )
  )[0]?.base_currency;
  if (!currency)
    refuse("subsidiary_invalid", "the legal entity does not exist in this organization");
  const posted = await postEntry(tx, {
    orgId: args.orgId,
    bookId,
    subsidiaryId: args.subsidiaryId,
    entryNumber: args.entryNumber,
    postingDate: args.date,
    periodId,
    memo: args.memo,
    origin: CAPITALIZATION_ORIGIN,
    actorId: args.actorId,
    currency,
    idempotencyKey: args.idempotencyKey,
    closeModules: ["assets"],
    lines: lines.map((line, index) => ({
      accountId: line.accountId,
      amount: add(line.amount, "0"),
      memo: line.memo,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      lineNumber: index + 1,
    })),
  });
  return {
    entryId: posted.entryId,
    lines: posted.lines.slice(0, lines.length).map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      accountId: lines[line.lineNumber - 1]!.accountId,
      amount: add(lines[line.lineNumber - 1]!.amount, "0"),
    })),
  };
}

/**
 * Post the mirror of a capitalization entry dated `date`. The caller marks
 * its own record reversed and only then calls `markCapitalizationEntryReversed`,
 * because the source-reversal fence refuses to flip an entry a posted
 * acceptance or capitalization still depends on.
 */
export async function postCapitalizationReversal(
  tx: SqlExecutor,
  args: { orgId: string; actorId: string; entryId: string; date: string; reason: string },
): Promise<string> {
  const source = (
    await tx.execute<{
      entry_number: string;
      subsidiary_id: string;
      book_id: string;
      status: string;
      posting_date: string;
      origin: string;
    }>(
      sql`
    select entry_number, subsidiary_id, book_id, status, posting_date::text as posting_date, origin
      from journal_entries where org_id = ${args.orgId} and id = ${args.entryId} for update`,
      "objects",
    )
  )[0];
  if (!source || source.origin !== CAPITALIZATION_ORIGIN)
    refuse("entry_not_found", "the capitalization journal was not found", { status: 404 });
  if (source.status !== "posted")
    refuse("entry_not_posted", `journal ${source.entry_number} is ${source.status}, not posted`);
  if (args.date < source.posting_date) {
    refuse(
      "reversal_before_entry",
      `the reversal date cannot precede the original posting date ${source.posting_date}`,
    );
  }
  const periodId = await openPeriodFor(tx, {
    orgId: args.orgId,
    bookId: source.book_id,
    subsidiaryId: source.subsidiary_id,
    date: args.date,
  });
  const lines = await tx.execute<{
    line_number: number;
    account_id: string;
    subsidiary_id: string;
    amount: string;
    currency: string;
    txn_amount: string;
    fx_rate: string;
    memo: string | null;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
  }>(
    sql`
    select line_number, account_id, subsidiary_id, amount::text as amount, currency,
           txn_amount::text as txn_amount, fx_rate::text as fx_rate, memo,
           department_id, project_id, location_id
      from journal_lines where org_id = ${args.orgId} and entry_id = ${args.entryId}
     order by line_number`,
    "objects",
  );
  const posted = await postEntry(tx, {
    orgId: args.orgId,
    bookId: source.book_id,
    subsidiaryId: source.subsidiary_id,
    entryNumber: `${source.entry_number}-REV`,
    postingDate: args.date,
    periodId,
    memo: `Reversal — ${args.reason}`,
    origin: CAPITALIZATION_ORIGIN,
    reversesEntryId: args.entryId,
    actorId: args.actorId,
    idempotencyKey: `asset-capitalization-reversal:${args.entryId}`,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      subsidiaryId: line.subsidiary_id,
      amount: neg(line.amount),
      currency: line.currency,
      txnAmount: neg(line.txn_amount),
      fxRate: line.fx_rate,
      memo: `Reversal — ${args.reason}`,
      departmentId: line.department_id,
      projectId: line.project_id,
      locationId: line.location_id,
      lineNumber: line.line_number,
    })),
  });
  return posted.entryId;
}

export async function markCapitalizationEntryReversed(
  tx: SqlExecutor,
  args: { orgId: string; actorId: string; entryId: string },
): Promise<void> {
  await markEntryReversed(tx, { orgId: args.orgId, entryId: args.entryId, actorId: args.actorId });
}
