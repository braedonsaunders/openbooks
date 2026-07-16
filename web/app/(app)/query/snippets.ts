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
    sql: `select a.number, a.name, sum(l.amount) as balance
  from journal_lines l
  join accounts a on a.id = l.account_id
 group by a.number, a.name
having sum(l.amount) <> 0
 order by a.number
 limit 200`,
  },
  {
    key: 'topAccounts',
    sql: `select a.number, a.name, sum(l.amount) as balance
  from journal_lines l
  join accounts a on a.id = l.account_id
 group by a.number, a.name
 order by abs(sum(l.amount)) desc
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
    sql: `select date_trunc('month', e.posting_date)::date as month,
       count(distinct e.id)                       as entries,
       sum(case when l.amount > 0 then l.amount else 0 end) as debits
  from journal_entries e
  join journal_lines l on l.entry_id = e.id
 where e.status = 'posted'
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
    sql: `select relname as table, n_live_tup as est_rows
  from pg_stat_user_tables
 order by n_live_tup desc
 limit 30`,
  },
  {
    key: 'listColumns',
    sql: `select table_name, column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
 order by table_name, ordinal_position
 limit 200`,
  },
]
