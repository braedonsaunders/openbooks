import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { isZero, neg } from "../money/money.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext, SubsidiaryError, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  batchDepositTieout,
  primaryBookId,
  periodForDate,
  PspSettlementError,
  validateSettlementPostingAccounts,
} from "./psp-settlement.ts";

/**
 * Month-end in-transit accruals for provider payouts. A posted payout that
 * has not tied to a bank deposit by period end is reclassed out of the bank
 * account back into its clearing account (the in-transit presentation), with
 * a mirror reversal dated the next day. Both legs post through the one
 * ledger API with per-effect idempotency keys, so a rerun converges: an
 * existing accrual row for (batch, accrual date) is returned, never
 * double-booked. Posted history stays immutable — the settlement journal is
 * never edited, only reclassed by dated entries that reverse themselves.
 */

export interface PayoutAccrualRunResult {
  accrualDate: string;
  reversalDate: string;
  accrued: { batchId: string; entryId: string }[];
  reversed: { accrualId: string; entryId: string }[];
  skipped: { batchId: string; reason: string }[];
}

/** Fail closed when the banking surface is off: hidden means refused. */
async function requireBankingFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "banking"))) {
    throw new PspSettlementError(
      "Payout reconciliation is disabled; enable Banking in Company Settings → Features before accruing in-transit payouts",
    );
  }
}

function auditAccrual(
  orgId: string,
  accrualId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string | null,
): Promise<unknown> {
  return db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'psp_payout_accruals', ${accrualId}, ${action},
            ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

type AccrualBatchRow = {
  id: string;
  provider: string;
  external_ref: string;
  currency: string;
  net_amount: string;
  bank_account_id: string | null;
  clearing_account_id: string | null;
  subsidiary_id: string | null;
};

export async function accruePayoutsInTransit(
  orgId: string,
  accrualDate: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PayoutAccrualRunResult> {
  if (!isIsoCalendarDate(accrualDate)) {
    throw new PspSettlementError(
      `accrual date ${accrualDate} is not a calendar date; accrue in-transit payouts as of a YYYY-MM-DD period-end date`,
    );
  }
  const reversalDate = addCalendarDays(accrualDate, 1);
  await assertNotSandbox(orgId, "accrue payouts in transit");
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const accrualPeriodId = await periodForDate(orgId, accrualDate);
    if (!accrualPeriodId) {
      throw new PspSettlementError(
        `no open accounting period for ${accrualDate}; open the period under Close before accruing in-transit payouts`,
      );
    }
    // The reversal posts the next day, which can fall in the next period: it
    // must be open too, or the accrual would strand without its reversal.
    const reversalPeriodId = await periodForDate(orgId, reversalDate);
    if (!reversalPeriodId) {
      throw new PspSettlementError(
        `no open accounting period for ${reversalDate}; the in-transit reversal posts the next day, so open that period under Close before accruing`,
      );
    }
    const bookId = await primaryBookId(orgId);
    const ctx = await loadSubsidiaryContext(db, orgId);
    const result: PayoutAccrualRunResult = { accrualDate, reversalDate, accrued: [], reversed: [], skipped: [] };

    // Reverse what came due first: last period's presentation clears before
    // this period's is taken, so the clearing account never double-holds.
    const due = (await db.execute<{
      id: string;
      batch_id: string;
      accrual_entry_id: string;
      amount: string;
      currency: string;
      bank_account_id: string | null;
      transit_account_id: string | null;
      subsidiary_id: string | null;
    }>(sql`
      select id, batch_id, accrual_entry_id, amount::text, currency,
             bank_account_id, transit_account_id, subsidiary_id
        from psp_payout_accruals
       where org_id = ${orgId} and status = 'accrued' and reversal_date <= ${accrualDate}
       order by reversal_date, batch_id
       for update
    `)).rows;
    for (const row of due) {
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id)) throw new ScopeNotFoundError();
      if (!row.bank_account_id || !row.transit_account_id) {
        throw new PspSettlementError(
          "in-transit reversal is missing its bank or clearing account; re-accrue the payout after repairing its settlement accounts",
        );
      }
      const subsidiaryId: string = row.subsidiary_id ?? ctx.rootId;
      await assertPeriodModulesOpen(db, {
        orgId,
        periodId: reversalPeriodId,
        bookId,
        subsidiaryIds: [subsidiaryId],
        modules: ["banking"],
      });
      // Mirror the accrual legs exactly: what left the bank returns.
      const posted = await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId,
        entryNumber: `PSP-INTRANSIT-${row.batch_id}-${accrualDate}-REVERSAL`,
        postingDate: reversalDate,
        periodId: reversalPeriodId,
        memo: `In-transit payout reversal`,
        origin: "accrual",
        reversesEntryId: row.accrual_entry_id,
        actorId,
        currency: row.currency,
        idempotencyKey: `psp-in-transit|${orgId}|${row.batch_id}|${accrualDate}|reversal`,
        lines: [
          { accountId: row.bank_account_id, amount: row.amount, memo: "In-transit payout returned to bank" },
          { accountId: row.transit_account_id, amount: neg(row.amount), memo: "In-transit clearing released" },
        ],
      });
      const stamped = await db.execute(sql`
        update psp_payout_accruals
           set status = 'reversed', reversal_entry_id = ${posted.entryId},
               updated_at = now(), updated_by = ${actorId}
         where id = ${row.id} and org_id = ${orgId} and status = 'accrued'
      `);
      if ((stamped.rowCount ?? 0) !== 1) {
        throw new PspSettlementError("in-transit accrual could not be marked reversed; run the accrual again");
      }
      await auditAccrual(orgId, row.id, "reverse", { reversalEntryId: posted.entryId }, actorId);
      result.reversed.push({ accrualId: row.id, entryId: posted.entryId });
    }

    const batches = (await db.execute<AccrualBatchRow>(sql`
      select b.id, b.provider, b.external_ref, b.currency, b.net_amount::text,
             b.bank_account_id, b.clearing_account_id, b.subsidiary_id
        from psp_settlement_batches b
        left join psp_payout_accruals a
          on a.org_id = b.org_id and a.batch_id = b.id and a.accrual_date = ${accrualDate}::date
       where b.org_id = ${orgId} and b.status = 'posted'
         and b.settlement_date <= ${accrualDate}::date
         and a.id is null
       order by b.settlement_date, b.id
    `)).rows;
    for (const batch of batches) {
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id)) continue;
      if (!batch.bank_account_id || !batch.clearing_account_id) {
        result.skipped.push({
          batchId: batch.id,
          reason: "settlement is missing its bank or clearing account; re-import the provider reference with posting accounts",
        });
        continue;
      }
      if (isZero(batch.net_amount)) {
        result.skipped.push({ batchId: batch.id, reason: "zero-net payout needs no in-transit reclass" });
        continue;
      }
      const tieout = await batchDepositTieout(orgId, batch.id, allowedSubsidiaryIds);
      if (tieout.status === "tied") {
        result.skipped.push({ batchId: batch.id, reason: "payout already tied to its bank deposit" });
        continue;
      }
      if (!batch.subsidiary_id && ctx.multi) {
        result.skipped.push({
          batchId: batch.id,
          reason: "settlement names no subsidiary in a multi-entity organization; re-import the provider reference with a subsidiary",
        });
        continue;
      }
      const subsidiaryId: string = batch.subsidiary_id ?? ctx.rootId;
      await validateSettlementPostingAccounts(
        orgId,
        [
          { label: "bank", id: batch.bank_account_id },
          { label: "clearing", id: batch.clearing_account_id },
        ],
        allowedSubsidiaryIds,
        batch.subsidiary_id,
      );
      await assertPeriodModulesOpen(db, {
        orgId,
        periodId: accrualPeriodId,
        bookId,
        subsidiaryIds: [subsidiaryId],
        modules: ["banking"],
      });
      try {
        await validateSubsidiaryRestrictions(db, {
          orgId,
          ctx,
          docSubsidiaryId: subsidiaryId,
          lines: [
            { accountId: batch.clearing_account_id, amount: batch.net_amount, subsidiaryId },
            { accountId: batch.bank_account_id, amount: neg(batch.net_amount), subsidiaryId },
          ],
        });
      } catch (error) {
        if (error instanceof SubsidiaryError) {
          result.skipped.push({ batchId: batch.id, reason: error.message });
          continue;
        }
        throw error;
      }
      const posted = await postEntry(db, {
        orgId,
        bookId,
        subsidiaryId,
        entryNumber: `PSP-INTRANSIT-${batch.provider.toUpperCase()}-${batch.external_ref}-${accrualDate}`,
        postingDate: accrualDate,
        periodId: accrualPeriodId,
        memo: `In-transit payout ${batch.provider} ${batch.external_ref} at ${accrualDate}`,
        origin: "accrual",
        actorId,
        currency: batch.currency,
        idempotencyKey: `psp-in-transit|${orgId}|${batch.id}|${accrualDate}`,
        lines: [
          { accountId: batch.clearing_account_id, amount: batch.net_amount, memo: "Payout in transit" },
          { accountId: batch.bank_account_id, amount: neg(batch.net_amount), memo: "Payout not yet deposited" },
        ],
      });
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into psp_payout_accruals
          (org_id, batch_id, accrual_date, reversal_date, amount, currency,
           bank_account_id, transit_account_id, subsidiary_id,
           accrual_entry_id, status, created_by, updated_by)
        values (${orgId}, ${batch.id}, ${accrualDate}::date, ${reversalDate}::date,
                ${batch.net_amount}, ${batch.currency},
                ${batch.bank_account_id}, ${batch.clearing_account_id}, ${batch.subsidiary_id},
                ${posted.entryId}, 'accrued', ${actorId}, ${actorId})
        on conflict (org_id, batch_id, accrual_date) do nothing
        returning id
      `));
      const accrualId = inserted.rows[0]?.id ?? (await db.execute<{ id: string }>(sql`
        select id from psp_payout_accruals
         where org_id = ${orgId} and batch_id = ${batch.id} and accrual_date = ${accrualDate}::date
      `)).rows[0]?.id;
      if (!accrualId) {
        throw new PspSettlementError(
          `in-transit accrual for batch ${batch.id} could not be recorded; run the accrual again`,
        );
      }
      await auditAccrual(
        orgId, accrualId, "accrue",
        { batchId: batch.id, accrualDate, reversalDate, amount: batch.net_amount, accrualEntryId: posted.entryId },
        actorId,
      );
      result.accrued.push({ batchId: batch.id, entryId: posted.entryId });
    }
    return result;
  });
}

/** Outstanding in-transit exposure: accrued rows not yet reversed. */
export async function listOutstandingInTransit(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{
  accruals: {
    id: string;
    batchId: string;
    provider: string;
    externalRef: string;
    accrualDate: string;
    reversalDate: string;
    amount: string;
    currency: string;
  }[];
}> {
  return withOrg(orgId, async () => {
    const rows = (await db.execute<{
      id: string;
      batch_id: string;
      provider: string;
      external_ref: string;
      accrual_date: string;
      reversal_date: string;
      amount: string;
      currency: string;
      subsidiary_id: string | null;
    }>(sql`
      select a.id, a.batch_id, b.provider, b.external_ref,
             a.accrual_date::text, a.reversal_date::text, a.amount::text, a.currency, a.subsidiary_id
        from psp_payout_accruals a
        join psp_settlement_batches b on b.id = a.batch_id and b.org_id = a.org_id
       where a.org_id = ${orgId} and a.status = 'accrued'
       order by a.accrual_date, a.batch_id
    `)).rows;
    return {
      accruals: rows
        .filter((row) => subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id))
        .map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          provider: row.provider,
          externalRef: row.external_ref,
          accrualDate: row.accrual_date,
          reversalDate: row.reversal_date,
          amount: row.amount,
          currency: row.currency,
        })),
    };
  });
}
