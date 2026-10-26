import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
/**
 * Prepaid expense reconciliation and close readiness.
 *
 * The subledger balance of a deferral account as of a date is the sum of
 * its schedules' recorded balance changes through that date (deferral on
 * posting, activation of a carried-in balance, credits, catch-ups, write-
 * offs and cancellations) less the plan lines posted through it. The ledger
 * balance is the account's posted journal lines through the same date. Both
 * group by book, subsidiary, book currency and deferral account, so a
 * difference names exactly where the ledger and the schedules disagree.
 */
import { sql, type SQL } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";

export interface ReconciliationRow {
  bookId: string;
  subsidiaryId: string;
  currency: string;
  accountId: string;
  /** Deferral account balance in the general ledger. */
  ledger: string;
  /** Sum of the schedules' unamortized balances. */
  subledger: string;
  /** Ledger less subledger. */
  difference: string;
  openSchedules: number;
}

export interface ReconciliationScope {
  asOf: string;
  bookId?: string | null;
  /** Restrict to these subsidiaries (a restricted actor's reach); null is every subsidiary. */
  subsidiaryIds?: ReadonlySet<string> | null;
}

function subsidiaryClause(column: SQL, ids: ReadonlySet<string> | null | undefined): SQL {
  if (!ids) return sql``;
  return sql`and ${column} = any(${`{${[...ids].join(",")}}`}::uuid[])`;
}

/**
 * Reconcile every deferral account that a schedule uses (and every account
 * a template names) as of a date.
 */
export async function reconcileDeferralAccounts(
  runner: SqlExecutor,
  orgId: string,
  scope: ReconciliationScope,
): Promise<ReconciliationRow[]> {
  const bookFilterS = scope.bookId ? sql`and s.book_id = ${scope.bookId}` : sql``;
  const bookFilterJ = scope.bookId ? sql`and je.book_id = ${scope.bookId}` : sql``;
  const rows = await runner.execute<{
    book_id: string;
    subsidiary_id: string;
    currency: string;
    account_id: string;
    ledger: string;
    subledger: string;
    open_schedules: string;
  }>(
    sql`
    with deferral_accounts as (
      select deferral_account_id as account_id from expense_amortization_schedules where org_id = ${orgId}
      union
      select deferral_account_id from expense_amortization_templates where org_id = ${orgId}
    ),
    subledger as (
      select s.book_id, s.subsidiary_id, s.currency, s.deferral_account_id as account_id,
             coalesce((select sum(e.balance_delta) from expense_amortization_schedule_events e
                        where e.org_id = s.org_id and e.schedule_id = s.id and e.effective_on <= ${scope.asOf}), 0)
           - coalesce((select sum(l.planned_amount) from expense_amortization_schedule_lines l
                        where l.org_id = s.org_id and l.schedule_id = s.id and l.status = 'posted'
                          and l.period_end <= ${scope.asOf}), 0) as balance,
             s.status
        from expense_amortization_schedules s
       where s.org_id = ${orgId} ${bookFilterS} ${subsidiaryClause(sql`s.subsidiary_id`, scope.subsidiaryIds)}
    ),
    ledger as (
      select je.book_id, jl.subsidiary_id, public.accounting_book_currency(${orgId}, je.book_id, jl.subsidiary_id) as currency, jl.account_id, sum(jl.amount) as balance
        from journal_lines jl
        join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
        join subsidiaries sub on sub.org_id = jl.org_id and sub.id = jl.subsidiary_id
       where jl.org_id = ${orgId}
         and jl.account_id in (select account_id from deferral_accounts)
         and je.status in ('posted', 'reversed')
         and je.posting_date <= ${scope.asOf}
         and ${excludePeriodEndJournals(sql`je.origin`)}
         ${bookFilterJ} ${subsidiaryClause(sql`jl.subsidiary_id`, scope.subsidiaryIds)}
       group by je.book_id, jl.subsidiary_id, jl.account_id
    ),
    keys as (
      select book_id, subsidiary_id, currency, account_id from subledger
      union
      select book_id, subsidiary_id, currency, account_id from ledger
    )
    select k.book_id, k.subsidiary_id, k.currency, k.account_id,
           coalesce(l.balance, 0)::text as ledger,
           coalesce((select sum(s.balance) from subledger s
                      where s.book_id = k.book_id and s.subsidiary_id = k.subsidiary_id
                        and s.currency = k.currency and s.account_id = k.account_id), 0)::text as subledger,
           (select count(*) from subledger s
             where s.book_id = k.book_id and s.subsidiary_id = k.subsidiary_id
               and s.currency = k.currency and s.account_id = k.account_id
               and s.balance <> 0)::text as open_schedules
      from keys k
      left join ledger l on l.book_id = k.book_id and l.subsidiary_id = k.subsidiary_id
        and l.currency = k.currency and l.account_id = k.account_id
     order by k.book_id, k.subsidiary_id, k.currency, k.account_id`,
    "objects",
  );
  return rows.map((row) => {
    const ledger = toUnits(row.ledger);
    const subledger = toUnits(row.subledger);
    return {
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      currency: row.currency,
      accountId: row.account_id,
      ledger: fromUnits(ledger),
      subledger: fromUnits(subledger),
      difference: fromUnits(ledger - subledger),
      openSchedules: Number(row.open_schedules),
    };
  });
}

/**
 * Due, unposted amortization for a close: planned lines of active schedules
 * whose month ends on or before the period end, in the period's book and
 * entity scope. Zero means the close step is complete.
 */
export async function dueUnpostedAmortization(
  runner: SqlExecutor,
  orgId: string,
  scope: { endsOn: string; bookId: string; subsidiaryIds?: ReadonlySet<string> | null },
): Promise<{ lines: number; schedules: number }> {
  const row = (
    await runner.execute<{ lines: string; schedules: string }>(
      sql`
    select count(*)::text as lines, count(distinct s.id)::text as schedules
      from expense_amortization_schedule_lines l
      join expense_amortization_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
     where l.org_id = ${orgId} and l.status = 'planned' and s.status = 'active'
       and l.period_end <= ${scope.endsOn} and s.book_id = ${scope.bookId}
       ${subsidiaryClause(sql`s.subsidiary_id`, scope.subsidiaryIds)}`,
      "objects",
    )
  )[0];
  return { lines: Number(row?.lines ?? "0"), schedules: Number(row?.schedules ?? "0") };
}
