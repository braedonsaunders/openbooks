import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Fixed assets                                                        */
/* ------------------------------------------------------------------ */

export const FIXED_ASSET_BASE_JOINS = sql`
  left join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
  left join lateral (
    select coalesce(sum(l.posted_amount), 0) as accumulated
      from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where s.asset_id = a.id and s.org_id = a.org_id and l.posted_amount is not null
  ) depr on true`

const FIXED_ASSET_NBV_EXPR = sql`a.acquisition_cost - depr.accumulated`

export const FIXED_ASSET_BUILT_IN_EXPR: Record<string, SQL> = {
  asset_number: sql`a.asset_number`,
  name: sql`a.name`,
  category_name: sql`c.name`,
  acquisition_cost: sql`a.acquisition_cost`,
  accumulated: sql`depr.accumulated`,
  net_book_value: FIXED_ASSET_NBV_EXPR,
  serial_number: sql`a.serial_number`,
  status: sql`a.status`,
}

export const FIXED_ASSET_SORTS: Record<string, SQL> = {
  number: sql`a.asset_number`,
  name: sql`a.name`,
  category: sql`c.name`,
  cost: sql`a.acquisition_cost`,
  accumulated: sql`depr.accumulated`,
  nbv: FIXED_ASSET_NBV_EXPR,
  status: sql`a.status`,
}

function fixedAssetFilterPredicate(clause: FilterClause): SQL | null {
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
  switch (clause.key) {
    case 'status': return select(sql`a.status`)
    case 'category_id':
      if (clause.operator === 'eq') return sql`a.category_id = ${value}`
      if (clause.operator === 'ne') return sql`a.category_id <> ${value}`
      return null
    case 'acquired_on':
      if (clause.operator === 'eq') return sql`a.acquired_on = ${value}`
      if (clause.operator === 'gte') return sql`a.acquired_on >= ${value}`
      if (clause.operator === 'lte') return sql`a.acquired_on <= ${value}`
      if (clause.operator === 'between') return sql`a.acquired_on between ${value} and ${String(clause.to ?? '')}`
      return null
    case 'serial_number':
      if (clause.operator === 'eq') return sql`a.serial_number = ${value}`
      if (clause.operator === 'contains') return sql`a.serial_number ilike ${`%${value}%`}`
      if (clause.operator === 'is_set') return sql`coalesce(a.serial_number, '') <> ''`
      if (clause.operator === 'is_not_set') return sql`coalesce(a.serial_number, '') = ''`
      return null
    default: return null
  }
}

export function fixedAssetWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and a.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = fixedAssetFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.name ilike ${query} or a.asset_number ilike ${query} or a.serial_number ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
