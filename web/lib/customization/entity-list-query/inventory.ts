import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export const INVENTORY_ONHAND_BUILT_IN_EXPR: Record<string, SQL> = {
  item_name: sql`concat_ws(' · ', it.code, it.name)`,
  location_code: sql`sl.code`,
  quantity: sql`round(oh.quantity, 4)::text`,
  average_cost: sql`case when oh.quantity <> 0 then oh.value / oh.quantity else 0 end`,
  value: sql`oh.value`,
}

export const INVENTORY_ONHAND_SORTS: Record<string, SQL> = {
  item: sql`it.name`,
  location: sql`sl.code`,
  quantity: sql`oh.quantity`,
  average_cost: sql`case when oh.quantity <> 0 then oh.value / oh.quantity else 0 end`,
  value: sql`oh.value`,
}

function inventoryRefFilter(clause: FilterClause, itemColumn: SQL, locationColumn: SQL): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'item_id' ? itemColumn : clause.key === 'stock_location_id' ? locationColumn : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function inventoryOnhandWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`oh.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = inventoryRefFilter(filter, sql`oh.item_id`, sql`oh.stock_location_id`)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (it.name ilike ${query} or it.code ilike ${query} or sl.code ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

export const INVENTORY_MOVEMENT_BASE_JOINS = sql`
  join items it on it.id = m.item_id and it.org_id = m.org_id
  join stock_locations sl on sl.id = m.stock_location_id and sl.org_id = m.org_id`

export const INVENTORY_MOVEMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  movement_date: sql`to_char(m.moved_at, 'YYYY-MM-DD')`,
  kind: sql`m.kind`,
  item_name: sql`concat_ws(' · ', it.code, it.name)`,
  location_code: sql`sl.code`,
  quantity: sql`round(m.quantity, 4)::text`,
  unit_cost: sql`m.unit_cost`,
  total_value: sql`m.total_value`,
  status: sql`m.status`,
  memo: sql`m.memo`,
}

export const INVENTORY_MOVEMENT_SORTS: Record<string, SQL> = {
  date: sql`m.moved_at`,
  kind: sql`m.kind`,
  item: sql`it.name`,
  location: sql`sl.code`,
  quantity: sql`m.quantity`,
  unit_cost: sql`m.unit_cost`,
  value: sql`m.total_value`,
  status: sql`m.status`,
}

export function inventoryMovementWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`m.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const ref = inventoryRefFilter(filter, sql`m.item_id`, sql`m.stock_location_id`)
    if (ref) {
      parts.push(sql`and ${ref}`)
      continue
    }
    const value = Array.isArray(filter.value) ? String(filter.value[0] ?? '') : String(filter.value ?? '')
    if (filter.key === 'kind') {
      if (filter.operator === 'eq') parts.push(sql`and m.kind = ${value}`)
      else if (filter.operator === 'ne') parts.push(sql`and m.kind <> ${value}`)
    } else if (filter.key === 'moved_at') {
      if (filter.operator === 'eq') parts.push(sql`and m.moved_at::date = ${value}`)
      else if (filter.operator === 'gte') parts.push(sql`and m.moved_at::date >= ${value}`)
      else if (filter.operator === 'lte') parts.push(sql`and m.moved_at::date <= ${value}`)
      else if (filter.operator === 'between') parts.push(sql`and m.moved_at::date between ${value} and ${String(filter.to ?? '')}`)
    }
  }
  if (adhoc.filters?.kind) parts.push(sql`and m.kind = ${adhoc.filters.kind}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (it.name ilike ${query} or it.code ilike ${query} or sl.code ilike ${query} or m.memo ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
