import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export const BUDGET_BASE_JOINS = sql`
  join accounting_books budget_book on budget_book.id=bs.book_id and budget_book.org_id=bs.org_id
  left join lateral (
    select coalesce(sum(case when a.type in ('income','income_other') then -bl.amount else bl.amount end), 0) as amount
      from budget_lines bl
      left join accounts a on a.id=bl.account_id and a.org_id=bl.org_id
     where bl.scenario_id=bs.id and bl.org_id=bs.org_id
  ) budget_total on true`

export const BUDGET_BUILT_IN_EXPR: Record<string, SQL> = {
  name: sql`bs.name`,
  book_name: sql`budget_book.name`,
  fiscal_year: sql`bs.fiscal_year::text`,
  kind: sql`bs.kind`,
  status: sql`bs.status`,
  total_amount: sql`budget_total.amount`,
  updated: sql`to_char(bs.updated_at, 'YYYY-MM-DD HH24:MI')`,
}

export const BUDGET_SORTS: Record<string, SQL> = {
  name: sql`bs.name`,
  book: sql`budget_book.name`,
  year: sql`bs.fiscal_year`,
  kind: sql`bs.kind`,
  status: sql`bs.status`,
  total: sql`budget_total.amount`,
  updated: sql`bs.updated_at`,
}

function budgetFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const select = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`${column}::text in (${list})` : sql`${column}::text not in (${list})`
    }
    return null
  }
  if (clause.key === 'status') return select(sql`bs.status`)
  if (clause.key === 'kind') return select(sql`bs.kind`)
  if (clause.key === 'fiscal_year') return select(sql`bs.fiscal_year`)
  if (clause.key === 'book_id') {
    if (clause.operator === 'eq') return sql`bs.book_id = ${value}`
    if (clause.operator === 'ne') return sql`bs.book_id <> ${value}`
  }
  return null
}

export function budgetWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`bs.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = budgetFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and bs.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.kind) parts.push(sql`and bs.kind = ${adhoc.filters.kind}`)
  if (adhoc.filters?.fiscal_year) parts.push(sql`and bs.fiscal_year = ${adhoc.filters.fiscal_year}`)
  if (adhoc.filters?.book_id) parts.push(sql`and bs.book_id = ${adhoc.filters.book_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (bs.name ilike ${query} or bs.description ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
