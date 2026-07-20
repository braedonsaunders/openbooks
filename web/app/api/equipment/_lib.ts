import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export async function loadEquipment(id: string, orgId: string) {
  const unit = (await db.execute(sql`
    select e.*, i.name as charge_item_name, b.name as rate_book_name,
           f.asset_number as fixed_asset_number, f.acquisition_cost as fixed_asset_cost
      from equipment_units e
      left join items i on i.id = e.charge_item_id
      left join item_rate_books b on b.id = e.rate_book_id
      left join fixed_assets f on f.id = e.fixed_asset_id
     where e.id = ${id} and e.org_id = ${orgId}
  `)) as any
  if (!unit.rows[0]) return null
  const metrics = (await db.execute(sql`
    select
      coalesce((select sum(dl.base_quantity) from document_lines dl join documents d on d.id = dl.document_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as usage,
      coalesce((select sum(dl.cost_amount) from document_lines dl join documents d on d.id = dl.document_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as recovery,
      coalesce((select sum(dl.bill_amount) from document_lines dl join documents d on d.id = dl.document_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'project_charge' and d.status in ('approved','posted')), 0) as billable,
      coalesce((select sum(dl.amount) from document_lines dl join documents d on d.id = dl.document_id
        where dl.equipment_unit_id = ${id} and dl.org_id = ${orgId} and d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'), 0) as billed_revenue,
      coalesce((select sum(jl.amount) from journal_lines jl join journal_entries je on je.id = jl.entry_id
        left join documents d on d.id = je.source_document_id
        join accounts a on a.id = jl.account_id
        where jl.equipment_unit_id = ${id} and jl.org_id = ${orgId} and je.org_id = ${orgId} and je.status = 'posted'
          and a.type in ('expense','expense_other','expense_cogs') and coalesce(d.kind, '') <> 'project_charge' and jl.amount > 0), 0) as direct_costs,
      coalesce((select sum(dsl.posted_amount) from equipment_units eu
        join depreciation_schedules ds on ds.asset_id = eu.fixed_asset_id
        join depreciation_schedule_lines dsl on dsl.schedule_id = ds.id
        where eu.id = ${id} and eu.org_id = ${orgId} and dsl.journal_entry_id is not null), 0) as depreciation
  `)) as any
  return { unit: unit.rows[0], metrics: metrics.rows[0] }
}
