import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Product families                                                    */
/* ------------------------------------------------------------------ */

export const FAMILY_STATUS_EXPR = sql`f.status`

export const FAMILY_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`f.code`,
  name: sql`f.name`,
  category: sql`f.category`,
  kind: sql`f.kind`,
  default_rate: sql`f.default_rate`,
  default_unit: sql`f.default_unit`,
  status: FAMILY_STATUS_EXPR,
}

export const FAMILY_SORTS: Record<string, SQL> = {
  code: sql`f.code`,
  name: sql`f.name`,
  category: sql`f.category`,
  kind: sql`f.kind`,
  rate: sql`f.default_rate`,
  status: sql`f.status`,
}

function familyFilterPredicate(clause: FilterClause): SQL | null {
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
  if (clause.key === 'kind') return select(sql`f.kind`)
  if (clause.key === 'status') return select(FAMILY_STATUS_EXPR)
  if (clause.key === 'category') {
    if (clause.operator === 'eq') return sql`f.category = ${value}`
    if (clause.operator === 'contains') return sql`f.category ilike ${`%${value}%`}`
    if (clause.operator === 'is_set') return sql`coalesce(f.category, '') <> ''`
    if (clause.operator === 'is_not_set') return sql`coalesce(f.category, '') = ''`
  }
  return null
}

export function familyWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`f.org_id = ${orgId}`]
  const savedViewOwnsActivity = view.filters.some((filter) => filter.key === 'status')
  if (!adhoc.showInactive && !savedViewOwnsActivity) parts.push(sql`and f.status = 'active'`)
  for (const filter of view.filters) {
    const predicate = familyFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.kind) parts.push(sql`and f.kind = ${adhoc.filters.kind}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (f.name ilike ${query} or f.code ilike ${query} or f.category ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
