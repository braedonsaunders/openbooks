import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Equipment units                                                     */
/* ------------------------------------------------------------------ */

export const EQUIPMENT_BASE_JOINS = sql`
  left join items equipment_item on equipment_item.id=eu.charge_item_id and equipment_item.org_id=eu.org_id
  left join lateral (
    select coalesce(sum(dl.cost_amount) filter (where d.status in ('approved','posted')), 0) as recovery,
           coalesce(sum(dl.bill_amount) filter (where d.status in ('approved','posted')), 0) as billable
      from document_lines dl
      join documents d on d.id=dl.document_id and d.org_id=dl.org_id and d.kind='project_charge'
     where dl.equipment_unit_id=eu.id and dl.org_id=eu.org_id
  ) equipment_metrics on true`

export const EQUIPMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  unit_number: sql`eu.unit_number`,
  name: sql`eu.name`,
  charge_item: sql`equipment_item.name`,
  serial_number: sql`eu.serial_number`,
  purchase_price: sql`eu.purchase_price`,
  recovery: sql`equipment_metrics.recovery`,
  billable: sql`equipment_metrics.billable`,
  status: sql`eu.status`,
}

export const EQUIPMENT_SORTS: Record<string, SQL> = {
  number: sql`eu.unit_number`,
  name: sql`eu.name`,
  item: sql`equipment_item.name`,
  purchase: sql`eu.purchase_price`,
  recovery: sql`equipment_metrics.recovery`,
  billable: sql`equipment_metrics.billable`,
  status: sql`eu.status`,
}

function equipmentFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'status' ? sql`eu.status`
    : clause.key === 'charge_item_id' ? sql`eu.charge_item_id`
      : clause.key === 'fixed_asset_id' ? sql`eu.fixed_asset_id` : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function equipmentWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`eu.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and eu.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = equipmentFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and eu.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (eu.name ilike ${query} or eu.unit_number ilike ${query} or eu.serial_number ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
