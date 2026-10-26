import { sql } from "drizzle-orm";
import { inExecutorTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { neg } from "../money/money.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PspSettlementError } from "./psp-settlement-core.ts";
import { periodForDate } from "./psp-settlement-posting-context.ts";

type AccrualRow = {
  id: string;
  batch_id: string;
  accrual_date: string;
  reversal_date: string;
  accrual_entry_id: string | null;
  reversal_entry_id: string | null;
  amount: string;
  currency: string;
  bank_account_id: string | null;
  transit_account_id: string | null;
  subsidiary_id: string | null;
  status: string;
};

export async function reversePayoutAccrual(
  executor: SqlExecutor,
  input: {
    orgId: string;
    accrualId: string;
    actorId: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    subsidiaryId?: string | null;
    postingDate?: string;
  },
): Promise<{ accrualId: string; batchId: string; entryId: string; changed: boolean }> {
  return inExecutorTransaction(executor, async (tx) => {
    const row = (
      await tx.execute<AccrualRow>(
        sql`
      select id, batch_id, accrual_date::text, reversal_date::text,
             accrual_entry_id, reversal_entry_id, amount::text, currency,
             bank_account_id, transit_account_id, subsidiary_id, status
        from psp_payout_accruals
       where org_id = ${input.orgId} and id = ${input.accrualId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();

    const subsidiaryId = row.subsidiary_id ?? input.subsidiaryId ?? null;
    if (
      (row.subsidiary_id && input.subsidiaryId && row.subsidiary_id !== input.subsidiaryId) ||
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, subsidiaryId)
    ) {
      throw new ScopeNotFoundError();
    }
    if (row.status === "reversed") {
      if (!row.reversal_entry_id) {
        throw new PspSettlementError(
          "reversed in-transit accrual is missing its reversal journal entry",
        );
      }
      return {
        accrualId: row.id,
        batchId: row.batch_id,
        entryId: row.reversal_entry_id,
        changed: false,
      };
    }
    if (row.status !== "accrued" || !row.accrual_entry_id || !subsidiaryId) {
      throw new PspSettlementError(
        "in-transit accrual is missing its live journal entry or subsidiary",
      );
    }
    if (!row.bank_account_id || !row.transit_account_id) {
      throw new PspSettlementError(
        "in-transit reversal is missing its bank or clearing account; repair the settlement accounts before reversing the payout accrual",
      );
    }

    const postingDate = input.postingDate ?? row.reversal_date;
    if (!isIsoCalendarDate(postingDate)) {
      throw new PspSettlementError(
        `in-transit reversal date ${postingDate} is not a calendar date`,
      );
    }
    const periodId = await periodForDate(input.orgId, postingDate, subsidiaryId, tx);
    if (!periodId) {
      throw new PspSettlementError(
        `no open accounting period for ${postingDate}; open the subsidiary's period under Close before reversing the in-transit payout`,
      );
    }
    const original = (
      await tx.execute<{ book_id: string; status: string }>(
        sql`
      select book_id, status from journal_entries
       where id = ${row.accrual_entry_id} and org_id = ${input.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!original || original.status !== "posted") {
      throw new PspSettlementError(
        "in-transit accrual source journal is missing or already reversed",
      );
    }
    await assertPeriodModulesOpen(tx, {
      orgId: input.orgId,
      periodId,
      bookId: original.book_id,
      subsidiaryIds: [subsidiaryId],
      modules: ["banking"],
    });

    const posted = await postEntry(tx, {
      orgId: input.orgId,
      bookId: original.book_id,
      subsidiaryId,
      entryNumber: `PSP-INTRANSIT-${row.batch_id}-${row.accrual_date}-REVERSAL`,
      postingDate,
      periodId,
      memo: "In-transit payout reversal",
      origin: "accrual",
      reversesEntryId: row.accrual_entry_id,
      actorId: input.actorId,
      currency: row.currency,
      idempotencyKey: `psp-in-transit|${input.orgId}|${row.batch_id}|${row.accrual_date}|reversal`,
      lines: [
        // Keep the source line order so the ledger guard can prove that each
        // posted line mirrors the original by line number and dimensions.
        {
          accountId: row.transit_account_id,
          amount: neg(row.amount),
          memo: "In-transit clearing released",
        },
        {
          accountId: row.bank_account_id,
          amount: row.amount,
          memo: "In-transit payout returned to bank",
        },
      ],
    });
    await markEntryReversed(tx, {
      orgId: input.orgId,
      entryId: row.accrual_entry_id,
      actorId: input.actorId,
    });
    const stamped = await tx.execute<never>(sql`
      update psp_payout_accruals
         set status = 'reversed', reversal_entry_id = ${posted.entryId},
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${row.id} and org_id = ${input.orgId} and status = 'accrued'
    `);
    if ((stamped.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        "in-transit accrual could not be marked reversed; run the payout operation again",
      );
    }
    const audited = await tx.execute<never>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'psp_payout_accruals', ${row.id}, 'reverse',
              ${JSON.stringify({ reversalEntryId: posted.entryId, postingDate })}::jsonb, ${input.actorId})
    `);
    if ((audited.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(
        "in-transit accrual reversal could not be audited; run the payout operation again",
      );
    }
    return { accrualId: row.id, batchId: row.batch_id, entryId: posted.entryId, changed: true };
  });
}

export async function reverseOpenPayoutAccrualsForBatch(
  executor: SqlExecutor,
  input: {
    orgId: string;
    batchId: string;
    actorId: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    subsidiaryId: string;
    postingDate: string;
  },
): Promise<void> {
  const rows = await executor.execute<{ id: string }>(
    sql`
    select id from psp_payout_accruals
     where org_id = ${input.orgId} and batch_id = ${input.batchId} and status = 'accrued'
     order by accrual_date
     for update
  `,
    "objects",
  );
  for (const row of rows) {
    await reversePayoutAccrual(executor, {
      orgId: input.orgId,
      accrualId: row.id,
      actorId: input.actorId,
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      subsidiaryId: input.subsidiaryId,
      postingDate: input.postingDate,
    });
  }
}
