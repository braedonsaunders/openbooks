import "server-only";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { statementBookExpr } from "../gl-summary";

export type FinancialTrendRow = {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  revenue: string;
  cogs: string;
  expenses: string;
  gross_profit: string;
  net_income: string;
  gross_margin_percent: string | null;
  closing_cash: string;
};

/**
 * Exact posted-only performance and cash position for recent completed
 * periods. `subsidiaryIds` is the caller's visibility allowlist: undefined =
 * unrestricted (the org), an array = only lines in those entities (an empty
 * array therefore yields zero activity rather than widening to the org).
 * `bookId` selects the accounting book (the org's primary book when omitted —
 * the same statementBookExpr contract as every statement).
 *
 * Period boundaries follow the ledger's exact period identity, never a date
 * inferred from posting_date (engine/src/period-identity-contract.test.ts):
 * an activity row is the entries the ledger assigned to THAT period, so an
 * adjustment period's accruals (a separate ledger period sharing the final
 * regular period's dates) never masquerade as regular-period activity, and
 * adjustment periods are not trend rows. Closing cash is a balance as at the
 * period's end: every ledger period ending on or before it, adjustment
 * periods included, keyed by period identity as well.
 */
export async function financialTrends(
  orgId: string,
  limit = 15,
  subsidiaryIds?: readonly string[],
  bookId?: string | null,
): Promise<FinancialTrendRow[]> {
  const today = await businessToday(orgId);
  const cappedLimit = Math.max(2, Math.min(limit, 15));
  const scope = (column: ReturnType<typeof sql>) =>
    subsidiaryIds === undefined
      ? sql``
      : sql` and ${column} = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`;
  const book = statementBookExpr(orgId, bookId);
  const rows = (await db.execute<FinancialTrendRow>(sql`
    with recent as (
      select p.id, p.name, p.starts_on, p.ends_on
        from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       where p.org_id = ${orgId} and fc.is_default and fc.is_active
         and not p.is_adjustment and p.ends_on < ${today}
       order by p.ends_on desc limit ${cappedLimit}
    ), activity as (
      select p.id,
             coalesce(-sum(l.amount) filter (where a.type in ('income','income_other')), 0) as revenue,
             coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0) as cogs,
             coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other','expense_deferred')), 0) as expenses
        from recent p
        left join journal_entries e on e.org_id = ${orgId} and e.status in ('posted', 'reversed')
          and e.book_id = ${book}
          and e.period_id = p.id
        left join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id${scope(sql`l.subsidiary_id`)}
        left join accounts a on a.id = l.account_id and a.org_id = l.org_id
       group by p.id
    )
    select p.id, p.name, p.starts_on::text, p.ends_on::text,
           a.revenue::text, a.cogs::text, a.expenses::text,
           (a.revenue - a.cogs)::text as gross_profit,
           (a.revenue - a.cogs - a.expenses)::text as net_income,
           case when a.revenue = 0 then null else round(((a.revenue - a.cogs) / a.revenue) * 100, 2)::text end as gross_margin_percent,
           coalesce((
             select sum(jl.amount)
               from journal_lines jl
               join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
                and je.book_id = ${book}
               join accounting_periods ep on ep.id = je.period_id and ep.org_id = je.org_id
               join accounts ba on ba.id = jl.account_id and ba.org_id = jl.org_id and ba.type = 'asset_bank'
              where jl.org_id = ${orgId} and ep.ends_on <= p.ends_on${scope(sql`jl.subsidiary_id`)}
           ), 0)::text as closing_cash
      from recent p join activity a on a.id = p.id
     order by p.ends_on
  `));
  return rows.rows;
}
