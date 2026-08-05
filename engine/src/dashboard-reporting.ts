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
export function dashboardFinancialMetricsQuery(orgId: string) {
  return sql`
    select
      (select base_currency from orgs where id = ${orgId}) as base_currency,
      (select coalesce(sum(l.amount), 0)
         from journal_lines l
         join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
         join accounts a on a.id = l.account_id and a.type = 'asset_bank'
        where e.org_id = ${orgId}) as cash_balance,
      (select coalesce(sum(round(d.open_balance * d.fx_rate, 4)), 0)
         from documents d
        where d.org_id = ${orgId} and d.kind = 'customer_invoice'
          and d.status = 'posted' and d.open_balance > 0) as open_receivables,
      (select coalesce(sum(round(d.open_balance * d.fx_rate, 4)), 0)
         from documents d
        where d.org_id = ${orgId} and d.kind = 'customer_invoice'
          and d.status = 'posted' and d.open_balance > 0
          and d.due_date < current_date) as overdue_receivables,
      (select coalesce(sum(round(d.open_balance * d.fx_rate, 4)), 0)
         from documents d
        where d.org_id = ${orgId} and d.kind = 'vendor_bill'
          and d.status = 'posted' and d.open_balance > 0) as open_payables,
      (select coalesce(sum(round(d.open_balance * d.fx_rate, 4)), 0)
         from documents d
        where d.org_id = ${orgId} and d.kind = 'vendor_bill'
          and d.status = 'posted' and d.open_balance > 0
          and d.due_date < current_date) as overdue_payables
  `;
}
