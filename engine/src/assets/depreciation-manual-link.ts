import { assertLocalDepreciation } from "./depreciation-ownership.ts";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { canonicalPeriodLabel, type PeriodDisplayInput } from "../periods/period-policy.ts";
import {
  assertPostableDepreciationStatus,
  DepreciationRefusalError,
} from "./depreciation-errors.ts";
import { resolveAssetAccounts } from "./depreciation-schedule-math.ts";

export interface LinkManualDepreciationEntryResult {
  lineId: string;
  assetId: string;
  assetNumber: string;
  periodId: string;
  /** Locale-free label of the line's period (`P05 FY2026`). */
  periodName: string;
  /** The line period's fiscal position and dates, for display labels. */
  periodRef: PeriodDisplayInput;
  entryId: string;
  entryNumber: string;
  amount: string;
}

/**
 * Attach a posted hand journal entry as a schedule line's depreciation
 * evidence. When an operator posts depreciation by hand (for example while
 * a stale schedule blocks the run), the run would otherwise post the same
 * amount again later: a linked line carries posted evidence, so rebuilds
 * preserve it and Confirm never touches it.
 *
 * The link is the operator's attestation that the entry IS this period's
 * depreciation — the accounts are shared across assets, so no query can
 * prove which asset a hand entry was for. Validation keeps the attestation
 * plausible (posted, unlinked, same book/period/subsidiary, exact
 * debit/credit pair for the planned amount) and refuses anything else by
 * name; the audit row records who linked what to what.
 */
export async function linkManualDepreciationEntry(
  orgId: string,
  assetId: string,
  input: {
    lineId: string;
    entryId: string;
    actorId: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<LinkManualDepreciationEntryResult> {
  return withOrgTransaction(orgId, async () => {
    const lines = await db.execute<{
      id: string;
      custom: unknown;
      asset_id: string;
      asset_number: string;
      asset_name: string;
      asset_status: string;
      asset_subsidiary_id: string;
      period_id: string;
      fiscal_year: number;
      period_number: number;
      is_adjustment: boolean;
      period_starts_on: string;
      period_ends_on: string;
      planned_amount: string;
      posted_amount: string | null;
      journal_entry_id: string | null;
      asset_account: string | null;
      asset_accum: string | null;
      asset_expense: string | null;
      cat_asset: string | null;
      cat_accum: string | null;
      cat_expense: string | null;
      book_id: string;
    }>(
      sql`
      select l.id, a.custom, s.asset_id::text as asset_id, a.asset_number, a.name as asset_name, a.status as asset_status,
             a.subsidiary_id::text as asset_subsidiary_id, l.period_id::text as period_id,
             p.fiscal_year, p.period_number, p.is_adjustment,
             p.starts_on::text as period_starts_on, p.ends_on::text as period_ends_on,
             l.planned_amount::text as planned_amount, l.posted_amount::text as posted_amount,
             l.journal_entry_id::text as journal_entry_id,
             a.asset_account_id::text as asset_account, a.accumulated_depreciation_account_id::text as asset_accum,
             a.depreciation_expense_account_id::text as asset_expense,
             c.asset_account_id::text as cat_asset, c.accumulated_depreciation_account_id::text as cat_accum,
             c.depreciation_expense_account_id::text as cat_expense, s.book_id::text as book_id
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
        left join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
       where l.org_id = ${orgId} and l.id = ${input.lineId} and s.asset_id = ${assetId}
       ${input.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(input.allowedSubsidiaryIds)}::uuid[])` : sql``}
       for update of l`,
      "objects",
    );
    const line = lines[0];
    if (!line) {
      throw new DepreciationRefusalError("that schedule line does not belong to this asset");
    }
    assertLocalDepreciation(line.custom, line.asset_number);
    const periodRef: PeriodDisplayInput = {
      fiscalYear: Number(line.fiscal_year),
      periodNumber: Number(line.period_number),
      adjustment: line.is_adjustment,
      startsOn: line.period_starts_on,
      endsOn: line.period_ends_on,
    };
    const periodLabel = canonicalPeriodLabel(periodRef);
    if (line.posted_amount !== null || line.journal_entry_id !== null) {
      throw new DepreciationRefusalError(
        `${line.asset_number} ${periodLabel} is already posted; a posted line cannot take manual evidence`,
      );
    }
    assertPostableDepreciationStatus(line.asset_status, line.asset_number);
    const accounts = resolveAssetAccounts(
      {
        assetAccountId: line.asset_account,
        accumulatedDepreciationAccountId: line.asset_accum,
        depreciationExpenseAccountId: line.asset_expense,
      },
      {
        assetAccountId: line.cat_asset ?? "",
        accumulatedDepreciationAccountId: line.cat_accum ?? "",
        depreciationExpenseAccountId: line.cat_expense ?? "",
      },
    );
    if (
      !accounts.assetAccountId ||
      !accounts.accumulatedDepreciationAccountId ||
      !accounts.depreciationExpenseAccountId
    ) {
      throw new DepreciationRefusalError(
        `${line.asset_number} has no complete depreciation accounts; set the category or override accounts first`,
      );
    }

    const entries = await db.execute<{
      id: string;
      entry_number: string;
      status: string;
      origin: string | null;
      reverses_entry_id: string | null;
      book_id: string;
      period_id: string;
      subsidiary_id: string;
    }>(
      sql`
      select id::text as id, entry_number, status, origin,
             reverses_entry_id::text as reverses_entry_id,
             book_id::text as book_id, period_id::text as period_id, subsidiary_id::text as subsidiary_id
        from journal_entries
       where org_id = ${orgId} and id = ${input.entryId}
       for update`,
      "objects",
    );
    const entry = entries[0];
    if (!entry) {
      throw new DepreciationRefusalError("that journal entry does not exist in this organization");
    }
    if (entry.status !== "posted") {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} is ${entry.status}; only a posted entry can evidence depreciation`,
      );
    }
    if (entry.origin === "depreciation") {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} was posted by a depreciation run; run postings are already some line's evidence`,
      );
    }
    if (entry.reverses_entry_id !== null) {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} is itself a reversal; link the surviving entry instead`,
      );
    }
    const alreadyLinked = (
      await db.execute<{ id: string }>(
        sql`
      select id::text as id from depreciation_schedule_lines
       where org_id = ${orgId} and journal_entry_id = ${entry.id} limit 1`,
        "objects",
      )
    )[0];
    if (alreadyLinked) {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} already evidences another schedule line; one entry evidences one line`,
      );
    }
    if (
      entry.book_id !== line.book_id ||
      entry.period_id !== line.period_id ||
      entry.subsidiary_id !== line.asset_subsidiary_id
    ) {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} is not in this line's book, period, and subsidiary; only the matching entry can evidence ${line.asset_number} ${periodLabel}`,
      );
    }
    const legs = await db.execute<{ debit_total: string; credit_total: string }>(
      sql`
      select coalesce(sum(amount) filter (where account_id = ${accounts.depreciationExpenseAccountId}), 0)::text as debit_total,
             coalesce(sum(amount) filter (where account_id = ${accounts.accumulatedDepreciationAccountId}), 0)::text as credit_total
        from journal_lines
       where org_id = ${orgId} and entry_id = ${entry.id} and subsidiary_id = ${line.asset_subsidiary_id}`,
      "objects",
    );
    const debitTotal = legs[0]!.debit_total;
    const creditTotal = legs[0]!.credit_total;
    if (
      cmp(debitTotal, line.planned_amount) !== 0 ||
      cmp(creditTotal, `-${line.planned_amount}`) !== 0
    ) {
      throw new DepreciationRefusalError(
        `journal entry ${entry.entry_number} posts ${debitTotal} / ${creditTotal} to the depreciation accounts; ${line.asset_number} ${periodLabel} plans ${line.planned_amount}, so this entry cannot be its depreciation`,
      );
    }

    await db.execute(sql`
      update depreciation_schedule_lines
         set posted_amount = ${line.planned_amount}::numeric,
             journal_entry_id = ${entry.id}::uuid,
             updated_by = ${input.actorId},
             updated_at = now()
       where org_id = ${orgId} and id = ${line.id}`);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'depreciation_schedule_lines', ${line.id}::uuid, 'update', jsonb_build_object(
        'before', jsonb_build_object('posted_amount', null, 'journal_entry_id', null),
        'after', jsonb_build_object('posted_amount', ${line.planned_amount}::numeric, 'journal_entry_id', ${entry.id}::uuid),
        'reason', 'Link a posted manual journal entry as the schedule line depreciation evidence',
        'entryNumber', ${entry.entry_number}::text
      ), ${input.actorId})`);
    return {
      lineId: line.id,
      assetId: line.asset_id,
      assetNumber: line.asset_number,
      periodId: line.period_id,
      periodName: periodLabel,
      periodRef,
      entryId: entry.id,
      entryNumber: entry.entry_number,
      amount: line.planned_amount,
    };
  });
}
