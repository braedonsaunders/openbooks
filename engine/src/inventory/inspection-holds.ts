import { sql, type SQL } from "drizzle-orm";

/** A reversal retires a receipt's allocation claim while retaining all inspection evidence. */
export function inspectionSourceActive(inspection: SQL): SQL {
  return sql`((${inspection}.receipt_movement_id is null and exists(select 1 from mfg_work_orders work where work.org_id=${inspection}.org_id and work.id=${inspection}.work_order_id and work.status<>'cancelled')) or exists(
    select 1 from inventory_movements source join journal_entries source_entry
      on source_entry.org_id=source.org_id and source_entry.id=source.journal_entry_id
    where source.org_id=${inspection}.org_id and source.id=${inspection}.receipt_movement_id
      and source.status='posted' and source_entry.status='posted'
      and not exists(select 1 from inventory_movements reversal
        where reversal.org_id=source.org_id and reversal.reverses_movement_id=source.id and reversal.status='posted'))) `;
}

/** Repair history remains immutable; reversing its receipt reactivates the failed-stock claim. */
export function inspectionReworkAccepted(inspection:SQL):SQL {
  return sql`((${inspection}.rework_work_order_id is null and ${inspection}.rework_completed_at is not null)
    or (${inspection}.rework_work_order_id is not null and exists(
      select 1 from mfg_work_orders repair join inventory_movements receipt on receipt.org_id=repair.org_id
        join journal_entries entry on entry.org_id=receipt.org_id and entry.id=receipt.journal_entry_id
      where repair.org_id=${inspection}.org_id and repair.id=${inspection}.rework_work_order_id
        and repair.receipt_rework_inspection_id=${inspection}.id and repair.quantity_completed>=${inspection}.quantity
        and receipt.kind='assembly_build' and receipt.status='posted' and entry.status='posted' and entry.reverses_entry_id is null
        and entry.custom->>'work_order_number'=repair.number and receipt.item_id=${inspection}.item_id
        and receipt.quantity=${inspection}.quantity and receipt.lot_id is not distinct from ${inspection}.lot_id
        and receipt.serial_id is not distinct from ${inspection}.serial_id
    )) or (${inspection}.rework_work_order_id is not null and exists(
      select 1 from mfg_work_orders repair join financial_changes loss on loss.org_id=repair.org_id and loss.id=repair.loss_change_id
      where repair.org_id=${inspection}.org_id and repair.id=${inspection}.rework_work_order_id and repair.receipt_rework_inspection_id=${inspection}.id
        and repair.status='cancelled' and repair.quantity_completed=0 and repair.quantity_scrapped=${inspection}.quantity
        and loss.status='applied' and loss.domain='manufacturing' and loss.operation='work_order_loss_disposition' and loss.subject_id=repair.id
    )))`;
}

/** Inspection holds have their own lifecycle; releasing a manual hold never clears them. */
export function pendingInspectionHold(org:SQL,lot:SQL,serial:SQL,excludedInspection?:SQL):SQL {
  return sql`exists(select 1 from inventory_inspections inspection where inspection.org_id=${org}
    ${excludedInspection?sql`and inspection.id<>${excludedInspection}`:sql``}
    and ${inspectionSourceActive(sql`inspection`)}
    and ((inspection.lot_id is not null and inspection.lot_id=${lot}) or (inspection.serial_id is not null and inspection.serial_id=${serial}))
    and (inspection.status='pending' or (inspection.status='fail' and (inspection.disposition is null or (inspection.disposition='rework' and not ${inspectionReworkAccepted(sql`inspection`)})))))`;
}
export function inspectionHoldReason(org:SQL,lot:SQL,serial:SQL):SQL {
  return sql`(select 'Inspection: '||(inspection.plan_snapshot->>'name') from inventory_inspections inspection where inspection.org_id=${org}
    and ${inspectionSourceActive(sql`inspection`)}
    and ((inspection.lot_id is not null and inspection.lot_id=${lot}) or (inspection.serial_id is not null and inspection.serial_id=${serial}))
    and (inspection.status='pending' or (inspection.status='fail' and (inspection.disposition is null or (inspection.disposition='rework' and not ${inspectionReworkAccepted(sql`inspection`)})))) order by inspection.created_at,inspection.id limit 1)`;
}
