import { sql } from "drizzle-orm";

export type DashboardFinancialMetricsRow = {
  base_currency: string;
  cash_balance: string;
};

/**
 * Dashboard cash balance in base currency. The AR/AP tiles do NOT come from
 * here: summing the cached documents.open_balance diverged from the hubs
 * both ways in production (F-t01-002, F-t07-010 — stale caches and unnetted
 * credit memos), so the tiles read the shared openItems reader in
 * web/lib/cash/open-items.ts, the same doorway as the /ar and /ap hubs and
 * the aging report. One definition for same-labeled figures.
 */
/** `today` is the org business day (YYYY-MM-DD) — never the database UTC date. */
export function dashboardFinancialMetricsQuery(orgId: string, today: string) {
  // Cash reads the maintained gl_month_activity aggregate instead of summing
  // every bank journal line to date.
  // The cash leg is scoped to exactly ONE accounting book — the org's primary
  // book resolved in-query — like every other journal reader (see
  // statementBookExpr in web/lib/gl-summary.ts). An unscoped read fuses
  // parallel books: a secondary book's own bank representation would silently
  // double-count into the dashboard total while the statements report primary
  // only. An org without a primary book matches no rows (empty, not merged).
  // The cash leg stops AT today — whole summary months before today's month
  // plus today's month from the lines (the glAccountMovement split in
  // web/lib/gl-summary.ts). An unbounded read counts lines posted after the
  // business day, so the tile disagrees with the cash cockpit's as-of balance
  // by exactly those future-dated lines.
  const primaryBook = sql`(select b.id from accounting_books b where b.org_id = ${orgId} and b.is_primary order by b.created_at limit 1)`;
  return sql`
    select
      (select base_currency from orgs where id = ${orgId}) as base_currency,
      (select coalesce(sum(x.amt), 0)
         from (
           select (g.debit_total - g.credit_total) as amt
             from gl_month_activity g
             join accounts a on a.id = g.account_id and a.org_id = ${orgId} and a.type = 'asset_bank'
            where g.org_id = ${orgId}
              and g.book_id = ${primaryBook}
              and g.month < date_trunc('month', ${today}::date)::date
            union all
           select l.amount as amt
             from journal_lines l
             join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
              and e.status in ('posted', 'reversed')
              and e.book_id = ${primaryBook}
              and e.posting_date >= date_trunc('month', ${today}::date)::date
              and e.posting_date <= ${today}
             join accounts a on a.id = l.account_id and a.org_id = ${orgId} and a.type = 'asset_bank'
            where l.org_id = ${orgId}
         ) x) as cash_balance
  `;
}
