import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export const ITEM_STATUS_EXPR = sql`case when i.is_active then 'active' else 'inactive' end`

export const ITEM_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`i.code`,
  name: sql`i.name`,
  kind: sql`i.kind`,
  category: sql`i.category`,
  default_rate: sql`i.default_rate`,
  default_cost: sql`i.default_cost`,
  unit: sql`i.unit`,
  status: ITEM_STATUS_EXPR,
}

export const ITEM_SORTS: Record<string, SQL> = {
  code: sql`i.code`,
  name: sql`i.name`,
  kind: sql`i.kind`,
  category: sql`i.category`,
  rate: sql`i.default_rate`,
  cost: sql`i.default_cost`,
  status: sql`i.is_active`,
}

function itemFilterPredicate(clause: FilterClause): SQL | null {
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
  if (clause.key === 'kind') return select(sql`i.kind`)
  if (clause.key === 'status') return select(ITEM_STATUS_EXPR)
  if (clause.key === 'category') {
    if (clause.operator === 'eq') return sql`i.category = ${value}`
    if (clause.operator === 'contains') return sql`i.category ilike ${`%${value}%`}`
    if (clause.operator === 'is_set') return sql`coalesce(i.category, '') <> ''`
    if (clause.operator === 'is_not_set') return sql`coalesce(i.category, '') = ''`
  }
  return null
}

export function itemWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`i.org_id = ${orgId}`]
  const savedViewOwnsActivity = view.filters.some((filter) => filter.key === 'status')
  if (!adhoc.showInactive && !savedViewOwnsActivity) parts.push(sql`and i.is_active`)
  for (const filter of view.filters) {
    const predicate = itemFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.kind) parts.push(sql`and i.kind = ${adhoc.filters.kind}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (i.name ilike ${query} or i.code ilike ${query} or i.category ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
