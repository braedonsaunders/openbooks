import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const ACCOUNT_CLASS_EXPR = sql`case
  when a.type in ('asset_bank','asset_receivable','asset_current_other','asset_fixed','asset_other') then 'asset'
  when a.type in ('liability_payable','liability_card','liability_current_other','liability_long_term') then 'liability'
  when a.type = 'equity' then 'equity'
  when a.type in ('income','income_other') then 'income'
  else 'expense' end`

export const ACCOUNT_STATUS_EXPR = sql`case when a.is_active then 'active' else 'inactive' end`

/**
 * Each account's balance including its subtree. Months before the current one
 * come from the gl_month_activity summary and only the current month is read
 * from journal_lines — a fiscal-year start is always the first of a month, so
 * the as-of date is the only boundary that can split one. The previous form
 * ran a recursive descendant roll-up over the raw lines once per listed
 * account, which scanned the ledger dozens of times per page.
 */
export function accountBaseJoins(today: string): SQL {
  return sql`
  left join accounts parent on parent.id = a.parent_id and parent.org_id = a.org_id
  left join lateral (
    with recursive descendants(id) as (
      select a.id
      union all
      select child.id
        from accounts child
        join descendants tree on child.parent_id = tree.id
       where child.org_id = a.org_id
    ),
    fy as (
      select make_date(
        case when extract(month from ${today}::date) >= 4 then extract(year from ${today}::date)::int else extract(year from ${today}::date)::int - 1 end,
        4, 1) as starts_on
    ),
    movement as (
      select (g.debit_total - g.credit_total) as amt, g.month as d
        from gl_month_activity g
        join descendants tree on tree.id = g.account_id
       where g.org_id = a.org_id and g.month < date_trunc('month', ${today}::date)::date
      union all
      select l.amount, e.posting_date
        from journal_lines l
        join descendants tree on tree.id = l.account_id
        join journal_entries e on e.id = l.entry_id and e.org_id = a.org_id
         and e.status in ('posted', 'reversed')
         and e.posting_date >= date_trunc('month', ${today}::date)::date
         and e.posting_date <= ${today}::date
       where l.org_id = a.org_id
    )
    select coalesce(sum(m.amt), 0)
           * case when a.type in ('income','income_other','liability_payable','liability_card','liability_current_other','liability_long_term','equity') then -1 else 1 end as amount
      from movement m, fy
     where a.type not in ('income','income_other','cogs','expense','expense_other','expense_deferred')
        or m.d >= fy.starts_on
  ) account_balance on true`
}

export const ACCOUNT_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`a.number`,
  name: sql`a.name`,
  type: sql`a.type`,
  class: ACCOUNT_CLASS_EXPR,
  parent_name: sql`parent.name`,
  balance: sql`account_balance.amount`,
  is_summary: sql`case when a.is_summary then 'Yes' else 'No' end`,
  status: ACCOUNT_STATUS_EXPR,
}

export const ACCOUNT_SORTS: Record<string, SQL> = {
  number: sql`a.number`,
  name: sql`a.name`,
  type: sql`a.type`,
  class: ACCOUNT_CLASS_EXPR,
  parent: sql`parent.name`,
  balance: sql`account_balance.amount`,
  status: sql`a.is_active`,
}

function accountFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const select = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`${column} in (${list})` : sql`${column} not in (${list})`
    }
    return null
  }
  if (clause.key === 'class') return select(ACCOUNT_CLASS_EXPR)
  if (clause.key === 'type') return select(sql`a.type`)
  if (clause.key === 'status') return select(ACCOUNT_STATUS_EXPR)
  if (clause.key === 'parent_id') {
    if (clause.operator === 'eq') return sql`a.parent_id = ${value}`
    if (clause.operator === 'ne') return sql`a.parent_id <> ${value}`
  }
  return null
}

export function accountWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  const savedViewOwnsActivity = view.filters.some((filter) => filter.key === 'status')
  if (!adhoc.showInactive && !savedViewOwnsActivity) parts.push(sql`and a.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (a.subsidiary_id is null or a.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = accountFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.class) parts.push(sql`and ${ACCOUNT_CLASS_EXPR} = ${adhoc.filters.class}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.name ilike ${query} or a.number ilike ${query} or a.description ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
