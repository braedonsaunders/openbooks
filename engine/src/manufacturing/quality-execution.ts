import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, cmp, sum } from "../money/money.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingManageAuthority, lockManufacturingReadAuthority } from "./authority.ts";
import { orderResourcesVisible } from "./resource-scope.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { assertInspectionIdentifierScope, auditInspectionChange, emitInspectionAvailability, inspectInventory, loadInspection, lockInspectionAuthority } from "../inventory/inspections.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import type { InspectionPlanSnapshot } from "../inventory/inspection-model.ts";
import { inspectionDecimal } from "../inventory/inspection-model.ts";
import { isUuid } from "../platform/uuid.ts";
import { resolveProfile } from "../inventory/profile-policy.ts";
import { assertTracking, ensureLot, ensureSerial } from "../inventory/tracking.ts";
import { assertManufacturingInspectionScope } from "./quality-workspace.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";

export async function assertQualityOrderVisible(tx:SqlExecutor,orgId:string,actorId:string,id:string,manage=false) {
  const work=(await tx.execute<{subsidiaryId:string|null}>(sql`select subsidiary_id as "subsidiaryId" from mfg_work_orders where org_id=${orgId} and id=${id}`)).rows[0];
  if (!work) throw new ManufacturingNotFoundError();
  const scope=manage ? await lockManufacturingManageAuthority(tx,orgId,actorId,work.subsidiaryId) : await lockManufacturingReadAuthority(tx,orgId,actorId,null,['manufacturing.read','items.read']);
  if (!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${id} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}`)).rows.length) throw new ManufacturingNotFoundError();
  return scope;
}

/** Operation plans were frozen at release. Starting work materializes that evidence without changing the revision. */
export async function createOperationInspection(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,operationId:string,followup?:{id:string;quantity:string}) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  await assertQualityOrderVisible(tx,orgId,actorId,workOrderId,true);
  const operation=(await tx.execute<{plan:InspectionPlanSnapshot|null;itemId:string;subsidiaryId:string;quantity:string;status:string}>(sql`select operation.inspection_plan_snapshot as plan,work.produced_item_id as "itemId",work.subsidiary_id as "subsidiaryId",operation.quantity_planned::text as quantity,operation.status from mfg_wo_operations operation join mfg_work_orders work on work.org_id=operation.org_id and work.id=operation.work_order_id where operation.org_id=${orgId} and operation.id=${operationId} and work.id=${workOrderId} for update of operation`)).rows[0];
  if (!operation) throw new ManufacturingNotFoundError();
  if (!operation.plan) return null;
  const prior=(await tx.execute<{id:string;status:string;quantity:string}>(sql`select id,status,quantity::text from inventory_inspections where org_id=${orgId} and operation_id=${operationId} order by inspection_sequence desc for share`)).rows;
  if (!followup && prior[0]) return prior[0];
  if (followup) {
    if (!isUuid(followup.id) || cmp(inspectionDecimal(followup.quantity,'Inspection quantity'),'0')<=0 || cmp(followup.quantity,operation.quantity)>0) throw new ManufacturingError("Enter an inspection quantity within the planned operation quantity.",{code:'inspection_quantity_invalid'});
    const replay=prior.find(row=>row.id===followup.id);
    if (replay) {if(cmp(replay.quantity,followup.quantity)!==0) throw new ManufacturingError("This inspection request has another quantity.",{code:'inspection_request_conflict',status:409});return replay;}
    if (!['running','paused'].includes(operation.status)) throw new ManufacturingError("Start or resume this operation before recording a follow-up inspection.",{code:'inspection_operation_not_running',status:409});
    if (prior.some(row=>row.status==='pending')) throw new ManufacturingError("Complete the pending inspection before starting another.",{code:'inspection_pending',status:409});
  }
  const inserted=await tx.execute<{id:string;inspectionSequence:number}>(sql`insert into inventory_inspections(id,org_id,plan_id,plan_snapshot,item_id,subsidiary_id,work_order_id,operation_id,quantity,created_by,updated_by)
    values(${followup?.id??sql`uuid_generate_v7()`},${orgId},${operation.plan.id},${JSON.stringify(operation.plan)}::jsonb,${operation.itemId},${operation.subsidiaryId},${workOrderId},${operationId},${followup?.quantity??operation.quantity},${actorId},${actorId}) returning id,inspection_sequence as "inspectionSequence"`);
  if (inserted.rows.length!==1) throw new ManufacturingError("The operation inspection was not created.",{code:'inspection_write_failed'});
  await auditInspectionChange(tx,orgId,actorId,'inventory_inspections',inserted.rows[0]!.id,null,{...operation,workOrderId,operationId,inspectionSequence:inserted.rows[0]!.inspectionSequence,status:'pending'});
  return inserted.rows[0]!;
}

export async function recordQualityInspection(tx:SqlExecutor,orgId:string,actorId:string,id:string,input:{outcome:'pass'|'fail';measurements:Record<string,string>;reason:string;quantity?:string;lotId?:string|null;serialId?:string|null}) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  const before=await loadInspection(tx,orgId,id);
  const scope=await lockInspectionAuthority(tx,orgId,actorId,before.subsidiaryId,['items.manage','manufacturing.manage']);
  await assertManufacturingInspectionScope(tx,orgId,id,scope);
  if (before.workOrderId) await assertQualityOrderVisible(tx,orgId,actorId,before.workOrderId,true);
  if (before.status!=='pending' && ((input.quantity!==undefined&&cmp(inspectionDecimal(input.quantity,'Inspection quantity'),before.quantity)!==0) || (input.lotId!==undefined&&input.lotId!==before.lotId) || (input.serialId!==undefined&&input.serialId!==before.serialId))) throw new ManufacturingError("This inspection retains its recorded quantity and tracking evidence.",{code:'inspection_request_conflict',status:409});
  if (before.operationId && before.status==='pending') {
    const quantity=input.quantity===undefined ? before.quantity : inspectionDecimal(input.quantity,'Inspection quantity');
    const operation=(await tx.execute<{planned:string;scrapped:string;status:string}>(sql`select quantity_planned::text as planned,quantity_scrapped_here::text as scrapped,status from mfg_wo_operations where org_id=${orgId} and id=${before.operationId} and work_order_id=${before.workOrderId} for update`)).rows[0];
    if (!operation || !['running','paused'].includes(operation.status) || cmp(quantity,'0')<=0 || cmp(quantity,operation.planned)>0) throw new ManufacturingError("Inspect a positive quantity within this running operation's plan.",{code:'inspection_quantity_invalid'});
    const lotId=input.lotId??before.lotId,serialId=input.serialId??before.serialId;
    if ((lotId&&!isUuid(lotId)) || (serialId&&!isUuid(serialId))) throw new ManufacturingNotFoundError();
    const profile=await resolveProfile(orgId,before.itemId,tx,true);
    if (profile.tracking!=='none'&&!lotId&&!serialId) throw new ManufacturingError("Identify the produced lot or serial before recording this operation's inspection.",{code:'inspection_tracking_required',remedy:'Register the finished lot or serial using Inventory and select it here.'});
    assertTracking(profile,{quantity,lotId,serialId},'issue');
    for (const [kind,identifier] of [['lot',lotId],['serial',serialId]] as const) if (identifier) {
      const row=(await tx.execute<{id:string;createdBy:string|null}>(sql`select id,created_by as "createdBy" from ${kind==='lot'?sql`lots`:sql`serials`} where org_id=${orgId} and id=${identifier} and item_id=${before.itemId} for update`)).rows[0];
      if (!row) throw new ManufacturingNotFoundError();
      if (scope!==null) {
        const owners=(await tx.execute<{subsidiaryId:string}>(sql`select distinct subsidiary_id as "subsidiaryId" from inventory_movements where org_id=${orgId} and ${kind==='lot'?sql`lot_id`:sql`serial_id`}=${identifier}
          union select distinct subsidiary_id from consignment_stock where org_id=${orgId} and ${kind==='lot'?sql`lot_id`:sql`serial_id`}=${identifier}`)).rows;
        if (owners.some(owner=>!scope.has(owner.subsidiaryId)) || (!owners.length && row.createdBy!==actorId)) throw new ManufacturingNotFoundError();
      }
    }
    if (serialId&&lotId) {
      const serial=(await tx.execute<{lotId:string|null;status:string}>(sql`select lot_id as "lotId",status from serials where org_id=${orgId} and id=${serialId} and item_id=${before.itemId} for update`)).rows[0];
      if (serial?.lotId===null && serial.status==='registered') {
        const bound=await tx.execute(sql`update serials set lot_id=${lotId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${serialId} and lot_id is null and status='registered' returning id`);
        if (bound.rows.length!==1) throw new ManufacturingError("The serial's lot changed; reload its inspection.",{code:'inspection_tracking_changed',status:409});
        await auditInspectionChange(tx,orgId,actorId,'serials',serialId,{lotId:null},{lotId,reason:'Production inspection establishes the registered serial lot.'});
      }
    }
    const changed=await tx.execute(sql`update inventory_inspections set quantity=${quantity},lot_id=${lotId},serial_id=${serialId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='pending' returning id`);
    if (changed.rows.length!==1) throw new ManufacturingError("The inspection changed; reload it.",{code:'inspection_changed',status:409});
  }
  return inspectInventory(tx,orgId,actorId,id,input);
}

/** Registration reuses the inventory catalog identity; the inspection remains the authority and ownership boundary. */
export async function registerInspectionIdentifier(tx:SqlExecutor,orgId:string,actorId:string,id:string,input:{kind:'lot'|'serial';number:string;expiresOn?:string|null}) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  const inspection=await loadInspection(tx,orgId,id);
  const scope=await lockInspectionAuthority(tx,orgId,actorId,inspection.subsidiaryId,['items.manage','manufacturing.manage']);
  await assertManufacturingInspectionScope(tx,orgId,id,scope);
  if (!inspection.operationId || inspection.status!=='pending' || !input.number?.trim() || input.number.length>200) throw new ManufacturingError("Register a lot or serial for a pending operation inspection.",{code:'inspection_tracking_refused'});
  if (input.expiresOn!=null && !isIsoCalendarDate(input.expiresOn)) throw new ManufacturingError("Enter a valid lot expiry date.",{code:'inspection_tracking_invalid'});
  const profile=await resolveProfile(orgId,inspection.itemId,tx,true);
  if ((input.kind==='lot'&&!['lot','lot_serial'].includes(profile.tracking)) || (input.kind==='serial'&&!['serial','lot_serial'].includes(profile.tracking))) throw new ManufacturingError("This identifier type does not match the item's tracking policy.",{code:'inspection_tracking_refused'});
  const existing=(await tx.execute<{id:string;createdBy:string|null}>(sql`select id,created_by as "createdBy" from ${input.kind==='lot'?sql`lots`:sql`serials`} where org_id=${orgId} and item_id=${inspection.itemId} and ${input.kind==='lot'?sql`lot_number`:sql`serial_number`}=${input.number.trim()} for update`)).rows[0];
  if (existing&&scope!==null) {
    const owners=(await tx.execute<{subsidiaryId:string}>(sql`select distinct subsidiary_id as "subsidiaryId" from inventory_movements where org_id=${orgId} and ${input.kind==='lot'?sql`lot_id`:sql`serial_id`}=${existing.id} union select distinct subsidiary_id from consignment_stock where org_id=${orgId} and ${input.kind==='lot'?sql`lot_id`:sql`serial_id`}=${existing.id}`)).rows;
    if (owners.some(owner=>!scope.has(owner.subsidiaryId)) || (!owners.length&&existing.createdBy!==actorId)) throw new ManufacturingNotFoundError();
  }
  const identifier=input.kind==='lot'?await ensureLot(orgId,inspection.itemId,input.number.trim(),input.expiresOn??null,actorId):await ensureSerial(orgId,inspection.itemId,input.number.trim(),null,actorId);
  await assertInspectionIdentifierScope(tx,orgId,actorId,inspection.itemId,scope,input.kind==='lot'?{lotId:identifier}:{serialId:identifier});
  return {id:identifier,label:input.number.trim()};
}

type AcceptedOperationInspection = { quantity:string;lotId:string|null;serialId:string|null };
const inspectionIdentity=(row:{lotId:string|null;serialId:string|null})=>`${row.lotId??''}:${row.serialId??''}`;

/** A repeated inspection replaces coverage for its identifier; it never counts the same units twice. */
async function acceptedOperationInspections(tx:SqlExecutor,orgId:string,operationId:string):Promise<AcceptedOperationInspection[]> {
  const rows=(await tx.execute<AcceptedOperationInspection & {status:string;disposition:string|null;reworkCompletedAt:Date|null}>(sql`select quantity::text,lot_id as "lotId",serial_id as "serialId",status,disposition,rework_completed_at as "reworkCompletedAt"
    from inventory_inspections where org_id=${orgId} and operation_id=${operationId} order by inspection_sequence desc for share`)).rows;
  const seen=new Set<string>(),accepted:AcceptedOperationInspection[]=[];
  for(const row of rows) {
    const identity=inspectionIdentity(row);
    if(seen.has(identity))continue;
    seen.add(identity);
    if(row.status==='pass'||row.disposition==='use_as_is'||(row.disposition==='rework'&&row.reworkCompletedAt))accepted.push(row);
  }
  return accepted;
}

export async function assertOperationInspectionAccepted(tx:SqlExecutor,orgId:string,operationId:string,doneQuantity:string) {
  const plan=(await tx.execute<{snapshot:InspectionPlanSnapshot|null}>(sql`select inspection_plan_snapshot as snapshot from mfg_wo_operations where org_id=${orgId} and id=${operationId}`)).rows[0]?.snapshot;
  if (!plan) return;
  if ((await tx.execute(sql`select id from inventory_inspections where org_id=${orgId} and operation_id=${operationId} and (status='pending' or (status='fail' and (disposition is null or (disposition='rework' and rework_completed_at is null)))) limit 1`)).rows.length) throw new ManufacturingError("Resolve every pending or failed inspection for this operation before completing it.",{code:'operation_inspection_unresolved',status:409,remedy:'Open the operation in Quality and finish its inspection or disposition.'});
  const accepted=await acceptedOperationInspections(tx,orgId,operationId);
  if (!accepted.length || cmp(sum(accepted.map(row=>row.quantity)),doneQuantity)<0) throw new ManufacturingError("This operation requires accepted inspections covering its completed quantity.",{code:'operation_inspection_required',status:409,remedy:'Inspect every produced lot or serial in Quality, or resolve failed results through a supported disposition.'});
}

export async function assertWorkOrderQualityForReceipt(tx:SqlExecutor,orgId:string,workOrderId:string,output?:{quantity:string;pieces:ReadonlyArray<{quantity:string;lotId:string|null;serialId:string|null}>}) {
  const unresolved=(await tx.execute(sql`select operation.id from mfg_wo_operations operation where operation.org_id=${orgId} and operation.work_order_id=${workOrderId} and operation.inspection_plan_snapshot is not null
    and (operation.status<>'done' or exists(select 1 from inventory_inspections earlier where earlier.org_id=operation.org_id and earlier.operation_id=operation.id and (earlier.status='pending' or (earlier.status='fail' and (earlier.disposition is null or (earlier.disposition='rework' and earlier.rework_completed_at is null)))))) limit 1`)).rows.length;
  if (unresolved) throw new ManufacturingError("A required operation inspection remains unresolved.",{code:'work_order_quality_pending',status:409,remedy:'Open Quality on the work order and complete the pending inspection or its disposition before receiving output.'});
  if(!output)return;
  const operations=(await tx.execute<{id:string;quantityDone:string}>(sql`select id,quantity_done::text as "quantityDone" from mfg_wo_operations
    where org_id=${orgId} and work_order_id=${workOrderId} and inspection_plan_snapshot is not null order by id for share`)).rows;
  if(!operations.length)return;
  const received=(await tx.execute<AcceptedOperationInspection>(sql`select sum(movement.quantity)::text as quantity,movement.lot_id as "lotId",movement.serial_id as "serialId"
    from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
    join mfg_work_orders work on work.org_id=movement.org_id and work.id=${workOrderId}
    where movement.org_id=${orgId} and movement.item_id=work.produced_item_id and movement.kind='assembly_build' and movement.quantity>0
      and movement.status='posted' and movement.reverses_movement_id is null and entry.status='posted' and entry.reverses_entry_id is null
      and entry.origin='manufacturing' and entry.custom->>'work_order_number'=work.number
    group by movement.lot_id,movement.serial_id`)).rows;
  const quantities=new Map<string,string>();
  for(const piece of [...received,...output.pieces]) {
    const identity=inspectionIdentity(piece);
    quantities.set(identity,add(quantities.get(identity)??'0',piece.quantity));
  }
  const recordedGood=sum([...quantities.values()]);
  for(const operation of operations) {
    const accepted=await acceptedOperationInspections(tx,orgId,operation.id);
    const coverage=new Map(accepted.map(row=>[inspectionIdentity(row),row.quantity]));
    if(cmp(output.quantity,operation.quantityDone)>0||cmp(recordedGood,operation.quantityDone)>0||[...quantities].some(([identity,quantity])=>!coverage.has(identity)||cmp(quantity,coverage.get(identity)!)>0))
      throw new ManufacturingError('Finished output exceeds its accepted operation inspections or uses different identifiers.',{code:'work_order_quality_output_mismatch',status:409,remedy:'Receive only the inspected lots or serials and their accepted quantities. Complete their required operation inspections before receiving output.'});
  }
}

export async function finishInspectionRework(tx:SqlExecutor,orgId:string,actorId:string,operationId:string) {
  const failed=(await tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${orgId} and rework_operation_id=${operationId} and disposition='rework' and rework_completed_at is null for update`)).rows;
  for (const inspection of failed) {
    const before=await loadInspection(tx,orgId,inspection.id);
    const accepted=(await tx.execute(sql`select repaired.id from inventory_inspections repaired join mfg_wo_operations operation on operation.org_id=repaired.org_id and operation.id=repaired.operation_id
      where repaired.org_id=${orgId} and repaired.operation_id=${operationId} and operation.status='done'
        and repaired.status='pass' and repaired.quantity>=${before.quantity} and operation.quantity_done>=${before.quantity}
        and repaired.lot_id is not distinct from ${before.lotId}::uuid and repaired.serial_id is not distinct from ${before.serialId}::uuid
        and not exists(select 1 from inventory_inspections newer where newer.org_id=repaired.org_id and newer.operation_id=repaired.operation_id
          and newer.lot_id is not distinct from repaired.lot_id and newer.serial_id is not distinct from repaired.serial_id and newer.inspection_sequence>repaired.inspection_sequence)
      order by repaired.inspection_sequence desc limit 1 for share of repaired,operation`)).rows.length;
    if (!accepted) throw new ManufacturingError("Rework must pass inspection for the same lot or serial and cover its failed quantity.",{code:'rework_inspection_required',status:409,remedy:'Record an accepted inspection for the repaired stock before completing its rework operation.'});
    const changed=await tx.execute(sql`update inventory_inspections set rework_completed_at=now(),updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${inspection.id} and rework_completed_at is null returning id`);
    if (changed.rows.length!==1) throw new ManufacturingError("The rework hold was not resolved.",{code:'inspection_write_failed'});
    await auditInspectionChange(tx,orgId,actorId,'inventory_inspections',inspection.id,{reworkCompletedAt:null},{operationId,operation:'rework_completed'});
    await emitInspectionAvailability(tx,orgId,before);
  }
}
