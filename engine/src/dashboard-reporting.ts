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
  return sql`
    select
      (select base_currency from orgs where id = ${orgId}) as base_currency,
      (select coalesce(sum(g.debit_total - g.credit_total), 0)
         from gl_month_activity g
         join accounts a on a.id = g.account_id and a.org_id = ${orgId} and a.type = 'asset_bank'
        where g.org_id = ${orgId}) as cash_balance,
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
