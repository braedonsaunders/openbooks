/**
 * Curated starter queries for the SQL console. SQL is code (never translated);
 * the label/description live under `query.snippets.<key>` in the message
 * catalogs. Each is a valid read-only SELECT against the real schema, meant to
 * teach the shape of the ledger and give a one-click running start.
 */
export interface Snippet {
  key: string
  sql: string
}

export const SNIPPETS: Snippet[] = [
  {
    key: 'trialBalance',
    sql: `-- gl_month_activity is the maintained per-(account, month) rollup of
-- posted lines, so a trial balance reads thousands of rows instead of
-- millions. Join journal_lines directly only when you need line detail.
select a.number, a.name, sum(g.debit_total - g.credit_total) as balance
  from gl_month_activity g
  join accounts a on a.id = g.account_id
 group by a.number, a.name
having sum(g.debit_total - g.credit_total) <> 0
 order by a.number
 limit 200`,
  },
  {
    key: 'topAccounts',
    sql: `select a.number, a.name, sum(g.debit_total - g.credit_total) as balance
  from gl_month_activity g
  join accounts a on a.id = g.account_id
 group by a.number, a.name
 order by abs(sum(g.debit_total - g.credit_total)) desc
 limit 15`,
  },
  {
    key: 'recentEntries',
    sql: `select e.entry_number, e.posting_date, e.memo, e.status, e.origin
  from journal_entries e
 order by e.posting_date desc, e.entry_number desc
 limit 50`,
  },
  {
    key: 'monthlyActivity',
    sql: `select g.month,
       sum(g.line_count)  as lines,
       sum(g.debit_total) as debits
  from gl_month_activity g
 group by 1
 order by 1 desc
 limit 24`,
  },
  {
    key: 'unbalancedEntries',
    sql: `select e.entry_number, e.posting_date, sum(l.amount) as imbalance
  from journal_entries e
  join journal_lines l on l.entry_id = e.id
 group by e.id, e.entry_number, e.posting_date
having abs(sum(l.amount)) > 0.005
 order by abs(sum(l.amount)) desc
 limit 50`,
  },
  {
    key: 'entriesByOrigin',
    sql: `select origin, count(*) as entries
  from journal_entries
 group by origin
 order by entries desc`,
  },
  {
    key: 'tableSizes',
    sql: `select table_name, count(*)::int as columns
  from information_schema.columns
 where table_schema = 'openbooks_query'
 group by table_name
 order by columns desc, table_name
 limit 100`,
  },
  {
    key: 'listColumns',
    sql: `select table_name, column_name, data_type
  from information_schema.columns
 where table_schema = 'openbooks_query'
 order by table_name, ordinal_position
 limit 200`,
  },
]
