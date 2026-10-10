import {createWorkOrder} from "./work-orders.ts";
import {lockManufacturingRoutingAuthority} from "./authority.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { cmp } from "../money/money.ts";
import { assertInspectionIdentifierScope, auditInspectionChange, emitInspectionAvailability, loadInspection, lockInspectionAuthority } from "../inventory/inspections.ts";
import { issueInventory } from "../inventory/movements.ts";
import { lockInventoryPosition } from "../inventory/position.ts";
import { resolveProfile } from "../inventory/profile-policy.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { assertQualityOrderVisible } from "./quality-execution.ts";
import { recordNormalScrap } from "./scrap.ts";
import { ManufacturingError } from "./errors.ts";
import { assertManufacturingInspectionScope } from "./quality-workspace.ts";

export interface QualityDispositionInput { action:'use_as_is'|'scrap'|'rework';reason:string;requestKey:string;scrapReasonId?:string;reworkRoutingId?:string;reworkSequence?:number }
export async function disposeQualityInspection(tx:SqlExecutor,orgId:string,actorId:string,id:string,input:QualityDispositionInput) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  const preview=await loadInspection(tx,orgId,id);
  const scope=await lockInspectionAuthority(tx,orgId,actorId,preview.subsidiaryId,['items.manage','manufacturing.manage',...(input.action==='use_as_is'?[]:['items.post'])]);
  await assertManufacturingInspectionScope(tx,orgId,id,scope);
  if (preview.workOrderId) await assertQualityOrderVisible(tx,orgId,actorId,preview.workOrderId,true);
  const reason=input.reason?.trim();
  if (!isUuid(input.requestKey) || !reason || reason.length<5 || reason.length>500 || !['use_as_is','scrap','rework'].includes(input.action)) throw new ManufacturingError("Choose a disposition and enter a reason of 5–500 characters.",{code:'quality_disposition_invalid'});
  const intent={action:input.action,reason,scrapReasonId:input.scrapReasonId??null,reworkRoutingId:input.reworkRoutingId??null,reworkSequence:input.reworkSequence??null};
  if (preview.workOrderId) await tx.execute(sql`select id from mfg_work_orders where org_id=${orgId} and id=${preview.workOrderId} for update`);
  if (preview.stockLocationId) await lockInventoryPosition(tx,preview.itemId,preview.stockLocationId);
  // Freeze allocation identifiers before deciding their disposition, using the same lock as picking.
  for (const [table,identifier] of [['lots',preview.lotId],['serials',preview.serialId]] as const) if (identifier) await tx.execute(sql`select id from ${table==='lots'?sql`lots`:sql`serials`} where org_id=${orgId} and id=${identifier} for update`);
  const before=await loadInspection(tx,orgId,id,true);
  await assertInspectionIdentifierScope(tx,orgId,actorId,before.itemId,scope,before);
  if (before.disposition!==null) {
    if (before.dispositionResult?.requestKey===input.requestKey && canonicalJson(before.dispositionResult.intent)===canonicalJson(intent)) return before;
    throw new ManufacturingError("This inspection already has an immutable disposition.",{code:'quality_disposition_conflict',status:409});
  }
  if (before.status!=='fail') throw new ManufacturingError("Only a failed inspection needs a disposition.",{code:'quality_disposition_refused',status:409});
  if (!before.sourceActive) throw new ManufacturingError("This inspection’s production or receipt source is no longer active. Its evidence is retained.",{code:'quality_source_reversed',status:409,remedy:'Inspect the replacement receipt before allocating its stock.'});
  let effect:Record<string,unknown>={},reworkOperationId:string|null=null,reworkWorkOrderId:string|null=null;
  if (input.action==='scrap') {
    if (before.receiptMovementId && before.stockLocationId) {
      const profile=await resolveProfile(orgId,before.itemId,tx,true);
      if (!profile.adjustmentAccountId) throw new ManufacturingError("Quality scrap requires the item's inventory adjustment account.",{code:'quality_scrap_account_required',remedy:'Configure the adjustment account on the inventory item before disposing stock.'});
      const result=await issueInventory(orgId,actorId,{tx,itemId:before.itemId,stockLocationId:before.stockLocationId,subsidiaryId:before.subsidiaryId,quantity:before.quantity,lotId:before.lotId,serialId:before.serialId,sourceReceiptMovementId:before.receiptMovementId,inspectionScrapId:id,date:await businessTodayInTx(tx,orgId),offsetAccountId:profile.adjustmentAccountId,memo:`Quality scrap: ${reason}`});
      effect={...result};
    } else if (before.workOrderId && before.operationId && isUuid(input.scrapReasonId??'')) {
      effect=await recordNormalScrap(tx,orgId,actorId,scope,before.workOrderId,input.requestKey,{operationId:before.operationId,quantity:before.quantity,reasonId:input.scrapReasonId!});
    } else throw new ManufacturingError("Choose a normal production scrap reason for this operation.",{code:'quality_scrap_reason_required'});
  } else if (input.action==='rework') {
    if(before.receiptMovementId&&before.stockLocationId) {
      if(!isUuid(input.reworkRoutingId??'')||!Number.isInteger(input.reworkSequence)||input.reworkSequence!<=0) throw new ManufacturingError('Choose an approved repair routing and operation.',{code:'quality_rework_routing_required',remedy:'Select an effective approved routing operation for this item. Manufacturing setup can create and approve one without a new recipe.'});
      await lockManufacturingRoutingAuthority(tx,orgId,actorId,input.reworkRoutingId!);
      const today=await businessTodayInTx(tx,orgId);
      if(!(await tx.execute(sql`select route.id from mfg_routings route join mfg_routing_operations operation on operation.org_id=route.org_id and operation.routing_id=route.id where route.org_id=${orgId} and route.id=${input.reworkRoutingId} and route.produced_item_id=${before.itemId} and route.status='active' and route.effective_from<=${today}::date and (route.effective_to is null or ${today}::date<route.effective_to) and operation.sequence=${input.reworkSequence} for share of route,operation`)).rows.length)throw new ManufacturingError('The selected repair operation is not effective for this item.',{code:'quality_rework_routing_unavailable',remedy:'Choose an effective approved operation for the inspected item.'});
      const order=await createWorkOrder(tx,orgId,actorId,{producedItemId:before.itemId,quantityOrdered:before.quantity,subsidiaryId:before.subsidiaryId,issueLocationId:before.stockLocationId,receiptLocationId:before.stockLocationId,routingId:input.reworkRoutingId,plannedStart:today},{id:input.requestKey,requestId:input.requestKey});
      if((await tx.execute(sql`update mfg_work_orders set receipt_rework_inspection_id=${id},receipt_rework_sequence=${input.reworkSequence},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${order.id} and status='draft' and receipt_rework_inspection_id is null returning id`)).rows.length!==1)throw new ManufacturingError('The repair draft was not linked to its failed receipt.',{code:'quality_write_failed'});
      reworkWorkOrderId=order.id;effect={workOrderId:order.id,workOrderNumber:order.number};
      await auditInspectionChange(tx,orgId,actorId,'mfg_work_orders',order.id,{receiptReworkInspectionId:null},{receiptReworkInspectionId:id,receiptReworkSequence:input.reworkSequence,reason});
    } else {
    if (!before.workOrderId || !before.operationId) throw new ManufacturingError('Choose an operation or received-stock repair.',{code:'quality_rework_source_required'});
    const work=(await tx.execute<{quantityCompleted:string;status:string}>(sql`select quantity_completed::text as "quantityCompleted",status from mfg_work_orders where org_id=${orgId} and id=${before.workOrderId} for update`)).rows[0];
    if (!work || !['released','in_progress'].includes(work.status) || cmp(work.quantityCompleted,'0')!==0) throw new ManufacturingError("An in-process rework operation must precede the first output receipt.",{code:'quality_rework_after_receipt',remedy:'Keep this lot or serial held while a separate rework order is prepared.'});
    const added=await tx.execute<{id:string}>(sql`insert into mfg_wo_operations(org_id,work_order_id,sequence,name,work_center_id,planned_setup_minutes,planned_run_minutes,labor_minutes_per_unit,labor_time_source,quantity_planned,quality_gate,backflush_at,inspection_plan_snapshot,
      standard_labor_wage_id,standard_labor_effective_from,standard_labor_rate,standard_labor_currency,standard_labor_basis,standard_labor_annual_hours,standard_labor_final_rate,standard_labor_functional_currency,standard_labor_burden,standard_labor_burden_hash,standard_labor_fx_class,standard_labor_fx_rate,standard_labor_fx_row_id,standard_labor_fx_date,standard_labor_fx_source,standard_labor_fx_direction,overhead_snapshot,overhead_snapshot_hash,created_by,updated_by)
      select org_id,work_order_id,(select coalesce(max(sequence),0)+10 from mfg_wo_operations where org_id=${orgId} and work_order_id=${before.workOrderId}),'Rework: '||name,work_center_id,planned_setup_minutes,planned_run_minutes,labor_minutes_per_unit,labor_time_source,${before.quantity},quality_gate,'none',inspection_plan_snapshot,
      standard_labor_wage_id,standard_labor_effective_from,standard_labor_rate,standard_labor_currency,standard_labor_basis,standard_labor_annual_hours,standard_labor_final_rate,standard_labor_functional_currency,standard_labor_burden,standard_labor_burden_hash,standard_labor_fx_class,standard_labor_fx_rate,standard_labor_fx_row_id,standard_labor_fx_date,standard_labor_fx_source,standard_labor_fx_direction,overhead_snapshot,overhead_snapshot_hash,${actorId},${actorId}
      from mfg_wo_operations where org_id=${orgId} and work_order_id=${before.workOrderId} and id=${before.operationId} returning id`);
    reworkOperationId=added.rows[0]?.id??null;
    if (!reworkOperationId) throw new ManufacturingError("The rework operation was not saved.",{code:'quality_write_failed'});
    effect={operationId:reworkOperationId,workOrderId:before.workOrderId};
    await auditInspectionChange(tx,orgId,actorId,'mfg_wo_operations',reworkOperationId,null,{...effect,sourceInspectionId:id,reason});
    }
  }
  const result={...effect,requestKey:input.requestKey,intent};
  const changed=await tx.execute(sql`update inventory_inspections set disposition=${input.action},disposition_reason=${reason},disposition_result=${JSON.stringify(result)}::jsonb,rework_operation_id=${reworkOperationId},rework_work_order_id=${reworkWorkOrderId},disposed_at=now(),disposed_by=${actorId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='fail' and disposition is null returning id`);
  if (changed.rows.length!==1) throw new ManufacturingError("The quality disposition changed; reload it.",{code:'quality_disposition_conflict',status:409});
  await auditInspectionChange(tx,orgId,actorId,'inventory_inspections',id,before,{disposition:input.action,reason,result});
  await emitInspectionAvailability(tx,orgId,before);
  return loadInspection(tx,orgId,id);
}
