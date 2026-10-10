import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../platform/db.ts';
import {cmp} from '../money/money.ts';
import {loadInspection,assertInspectionIdentifierScope,auditInspectionChange,emitInspectionAvailability} from '../inventory/inspections.ts';
import {repairableLocation} from '../inventory/stock-eligibility.ts';
import {pendingInspectionHold} from '../inventory/inspection-holds.ts';
import {validateTrackingSelection} from '../inventory/tracking.ts';
import {resolveProfile} from '../inventory/profile-policy.ts';
import {lockManufacturingOrderExecutionAuthority} from './authority.ts';
import {assertManufacturingFeature} from './gate.ts';
import {ManufacturingError,ManufacturingNotFoundError} from './errors.ts';

/** A repair consumes the exact failed receipt; no recipe or new item identity is invented. */
export async function loadReceiptRework(tx:SqlExecutor,orgId:string,workOrderId:string) {
  const work=(await tx.execute<{inspectionId:string|null;sequence:number|null}>(sql`select receipt_rework_inspection_id as "inspectionId",receipt_rework_sequence as sequence from mfg_work_orders where org_id=${orgId} and id=${workOrderId}`)).rows[0];
  if(!work)throw new ManufacturingNotFoundError();
  if(!work.inspectionId)return null;
  const inspection=await loadInspection(tx,orgId,work.inspectionId,true);
  if(inspection.status!=='fail'||inspection.disposition!=='rework'||inspection.reworkWorkOrderId!==workOrderId||!inspection.receiptMovementId||!inspection.stockLocationId||!work.sequence||!inspection.sourceActive)
    throw new ManufacturingError('The rework order needs its active failed receipt disposition.',{code:'receipt_rework_source_unavailable',status:409,remedy:'Review the failed inspection and its original receipt before releasing or executing this repair.'});
  return {...inspection,sequence:work.sequence};
}

/** Only a live native issue of the original inspected stock accounts for its repair input. */
export async function receiptReworkIssuedQuantity(tx:SqlExecutor,orgId:string,workOrderId:string,repair:NonNullable<Awaited<ReturnType<typeof loadReceiptRework>>>) {
  return (await tx.execute<{quantity:string}>(sql`select coalesce(sum(-movement.quantity),0)::text as quantity from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id where movement.org_id=${orgId} and entry.origin='manufacturing' and entry.custom->>'work_order_number'=(select number from mfg_work_orders where org_id=${orgId} and id=${workOrderId}) and entry.status='posted' and entry.reverses_entry_id is null and movement.kind='assembly_consume' and movement.item_id=${repair.itemId} and movement.lot_id is not distinct from ${repair.lotId}::uuid and movement.serial_id is not distinct from ${repair.serialId}::uuid`)).rows[0]!.quantity;
}

/** Only this retained disposition may consume its held identifier, with every other hold preserved. */
export async function assertReceiptReworkIssue(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,selection:{itemId:string;quantity:string;lotId:string|null;serialId:string|null;stockLocationId:string;subsidiaryId:string}) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  const scope=await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  const repair=await loadReceiptRework(tx,orgId,workOrderId);
  if(!repair||repair.itemId!==selection.itemId||repair.subsidiaryId!==selection.subsidiaryId||repair.stockLocationId!==selection.stockLocationId||repair.lotId!==selection.lotId||repair.serialId!==selection.serialId||cmp(repair.quantity,selection.quantity)!==0)
    throw new ManufacturingError('Issue exactly the failed receipt quantity and identifier into this rework order.',{code:'receipt_rework_issue_mismatch',status:409,remedy:'Use the repair’s original lot or serial, source location and full inspected quantity.'});
  await assertInspectionIdentifierScope(tx,orgId,actorId,repair.itemId,scope,repair);
  const allowed=(await tx.execute<{allowed:boolean}>(sql`select ${repairableLocation(sql`${orgId}`,sql`${repair.stockLocationId}::uuid`)}
    and not exists(select 1 from lots where org_id=${orgId} and id=${repair.lotId} and hold_reason is not null)
    and not exists(select 1 from serials where org_id=${orgId} and id=${repair.serialId} and hold_reason is not null)
    and not ${pendingInspectionHold(sql`${orgId}`,sql`${repair.lotId}::uuid`,sql`${repair.serialId}::uuid`,sql`${repair.id}::uuid`)} as allowed`)).rows[0]?.allowed;
  if(!allowed)throw new ManufacturingError('Another stock or inspection hold prevents this repair.',{code:'receipt_rework_other_hold',status:409,remedy:'Resolve the independent hold without clearing this failed inspection’s retained disposition.'});
  if((await tx.execute(sql`select movement.id from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id where movement.org_id=${orgId} and entry.origin='manufacturing' and entry.custom->>'work_order_number'=(select number from mfg_work_orders where org_id=${orgId} and id=${workOrderId}) and entry.status='posted' and movement.kind='assembly_consume' limit 1`)).rows.length)
    throw new ManufacturingError('The failed receipt has already been issued to this repair.',{code:'receipt_rework_already_issued',status:409,remedy:'Review the retained issue; use its controlled reversal before recording another issue.'});
  return repair;
}

/** Receiving the same serial is admitted only after its exact valued repair issue and accepted operation. */
export async function assertReceiptReworkOutput(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,quantity:string,pieces?:Array<{lotId:string|null;serialId:string|null}>,receiptLocationId?:string) {
  const scope=await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  const repair=await loadReceiptRework(tx,orgId,workOrderId);if(!repair)return null;
  if(cmp(quantity,repair.quantity)!==0||pieces&&pieces.some(piece=>piece.lotId!==repair.lotId||piece.serialId!==repair.serialId))
    throw new ManufacturingError('Receive the full repaired quantity with its original identifier.',{code:'receipt_rework_output_mismatch',status:409,remedy:'Use the inspected lot or serial and the full repair quantity. Dispose failed repair work through Quality or Close as loss.'});
  await assertInspectionIdentifierScope(tx,orgId,actorId,repair.itemId,scope,repair);
  const issued=await receiptReworkIssuedQuantity(tx,orgId,workOrderId,repair);
  if(cmp(issued,repair.quantity)!==0)throw new ManufacturingError('The repair has no complete live issue of its failed receipt.',{code:'receipt_rework_issue_required',status:409,remedy:'Issue its exact inspected stock before receiving repaired output.'});
  if(!(await tx.execute(sql`select operation.id from mfg_wo_operations operation join inventory_inspections accepted on accepted.org_id=operation.org_id and accepted.operation_id=operation.id where operation.org_id=${orgId} and operation.work_order_id=${workOrderId} and operation.sequence=${repair.sequence} and operation.status='done' and operation.quantity_done>=${repair.quantity} and accepted.status='pass' and accepted.quantity>=${repair.quantity} and accepted.lot_id is not distinct from ${repair.lotId}::uuid and accepted.serial_id is not distinct from ${repair.serialId}::uuid and not exists(select 1 from inventory_inspections newer where newer.org_id=accepted.org_id and newer.operation_id=accepted.operation_id and newer.lot_id is not distinct from accepted.lot_id and newer.serial_id is not distinct from accepted.serial_id and newer.inspection_sequence>accepted.inspection_sequence) limit 1`)).rows.length)
    throw new ManufacturingError('The repaired item must pass its frozen inspection before receipt.',{code:'receipt_rework_inspection_required',status:409,remedy:'Finish the repair operation with a passed inspection covering its original lot or serial and full quantity.'});
  if(pieces)for(const piece of pieces)await validateTrackingSelection(tx,orgId,repair.itemId,receiptLocationId??repair.stockLocationId!,await resolveProfile(orgId,repair.itemId,tx,true),{quantity,...piece},'count_receipt',actorId);
  return repair;
}

/** Retire the original claim through native received output or an applied whole-repair loss. */
export async function finishReceiptRework(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,resolution:'receipt'|'loss'='receipt') {
  const repair=await loadReceiptRework(tx,orgId,workOrderId);if(!repair)return;
  const changed=(await tx.execute(sql`update inventory_inspections set rework_completed_at=now(),updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${repair.id} and rework_work_order_id=${workOrderId} and rework_completed_at is null returning id`)).rows;
  if(changed.length||resolution==='loss')await auditInspectionChange(tx,orgId,actorId,'inventory_inspections',repair.id,{reworkCompletedAt:repair.reworkCompletedAt},{workOrderId,resolution,operation:resolution==='loss'?'receipt_rework_disposed':'receipt_rework_completed'});
  await emitInspectionAvailability(tx,orgId,repair);
}
