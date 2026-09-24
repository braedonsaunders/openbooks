import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'

async function loadEquipmentRows(
  executor: SqlExecutor,
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  const unit = ((await executor.execute(sql`
    select e.*, i.name as charge_item_name, b.name as rate_book_name,
           f.asset_number as fixed_asset_number, f.acquisition_cost as fixed_asset_cost
      from equipment_units e
      left join items i on i.id = e.charge_item_id and i.org_id = e.org_id
      left join item_rate_books b on b.id = e.rate_book_id and b.org_id = e.org_id
      left join fixed_assets f on f.id = e.fixed_asset_id and f.org_id = e.org_id
     where e.id = ${id} and e.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, allowedSubsidiaryIds)}
     for share of e
  `)))
  if (!unit.rows[0]) return null
  const metrics = ((await executor.execute(sql`
    select
      coalesce((select sum(dl.base_quantity) from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as usage,
      coalesce((select sum(dl.cost_amount) from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as recovery,
      coalesce((select sum(dl.bill_amount) from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as billable,
      coalesce((select sum(dl.amount) from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'), 0) as billed_revenue,
      coalesce((select sum(jl.amount) from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
        where jl.equipment_unit_id = ${id} and jl.org_id = ${orgId} and je.org_id = ${orgId} and je.status in ('posted', 'reversed')
          and a.type in ('expense','expense_other','cogs') and coalesce(d.kind, '') <> 'project_charge'), 0) as direct_costs,
      coalesce((select sum(dsl.posted_amount) from equipment_units eu
        join depreciation_schedules ds on ds.asset_id = eu.fixed_asset_id and ds.org_id = eu.org_id
        join depreciation_schedule_lines dsl on dsl.schedule_id = ds.id and dsl.org_id = ds.org_id
        where eu.id = ${id} and eu.org_id = ${orgId} and dsl.posted_amount is not null), 0) as depreciation
  `)))
  return { unit: unit.rows[0], metrics: metrics.rows[0] }
}

export async function loadEquipment(
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
) {
  // Scope check first, then one transaction for the unit and its
  // usage/revenue/cost aggregates, locking the unit row first (READ
  // COMMITTED, like loadAsset): a concurrent unit rehome blocks on the lock
  // instead of moving rows between the unit read and the metric reads of one
  // response. (A REPEATABLE READ snapshot cannot take the lock: a locking
  // read that meets a concurrent update errors with 40001 instead of
  // waiting.)
  return withOrgTransaction(orgId, () => loadEquipmentRows(db, id, orgId, allowedSubsidiaryIds))
}

/**
 * Reload inside the caller's own write transaction (the equipment PATCH
 * holds the unit FOR UPDATE there): opening a snapshot here would either
 * throw (isolation change inside an ambient unit) or self-deadlock (a
 * second connection locking the row the outer unit holds). The outer unit's
 * locks already pin the state, so the same scoped queries run on it.
 */
export async function loadEquipmentInWrite(
  tx: SqlExecutor,
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return loadEquipmentRows(tx, id, orgId, allowedSubsidiaryIds)
}
