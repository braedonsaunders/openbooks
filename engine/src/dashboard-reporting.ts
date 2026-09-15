import { sql } from "drizzle-orm";

export type DashboardFinancialMetricsRow = {
  base_currency: string;
  cash_balance: string;
  open_receivables: string;
  overdue_receivables: string;
  open_payables: string;
  overdue_payables: string;
};

/**
 * Exact base-currency dashboard balances. FX conversion is rounded per source
 * document to numeric(19,4), matching the posting engine, before totals are
 * summed. Summing transaction-currency open balances directly is forbidden.
 */
/** `today` is the org business day (YYYY-MM-DD) — never the database UTC date. */
export function dashboardFinancialMetricsQuery(orgId: string, today: string) {
  // Cash reads the maintained gl_month_activity aggregate instead of summing
  // every bank journal line to date; the four AR/AP tiles come from ONE pass
  // over the open documents with filtered sums instead of four separate scans.
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
         ) x) as cash_balance,
      o.open_receivables, o.overdue_receivables, o.open_payables, o.overdue_payables
    from (
      select
        coalesce(sum(round(d.open_balance * d.fx_rate, 4)) filter (where d.kind = 'customer_invoice'), 0) as open_receivables,
        coalesce(sum(round(d.open_balance * d.fx_rate, 4)) filter (where d.kind = 'customer_invoice' and d.due_date < ${today}), 0) as overdue_receivables,
        coalesce(sum(round(d.open_balance * d.fx_rate, 4)) filter (where d.kind = 'vendor_bill'), 0) as open_payables,
        coalesce(sum(round(d.open_balance * d.fx_rate, 4)) filter (where d.kind = 'vendor_bill' and d.due_date < ${today}), 0) as overdue_payables
        from documents d
       where d.org_id = ${orgId} and d.kind in ('customer_invoice', 'vendor_bill')
         and d.status = 'posted' and d.open_balance > 0
    ) o
  `;
}
