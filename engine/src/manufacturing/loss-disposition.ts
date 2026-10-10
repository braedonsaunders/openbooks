import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db,withOrgTransaction,type SqlExecutor} from '../platform/db.ts';
import {businessTodayInTx} from '../platform/business-date.ts';
import {isUuid} from '../platform/uuid.ts';
import {loadFinancialChange,existingFinancialChange,proposeFinancialChange,assertFinancialChangeApproved,completeFinancialChange,MANUFACTURING_LOSS_DISPOSITION_OPERATION} from '../platform/financial-changes.ts';
import {add,cmp,neg,sum} from '../money/money.ts';
import {resolveProfile} from '../inventory/profile-policy.ts';
import {unitCostPerQuantity} from '../inventory/costing.ts';
import {assertInventoryAccountsPostable} from '../inventory/journal.ts';
import {primaryBookId,periodForDate,subsidiaryCurrency} from '../inventory/position.ts';
import {previewOperationConversion,absorbOperationConversion,type ConversionOrder} from './conversion.ts';
import {lockManufacturingOrderExecutionAuthority} from './authority.ts';
import {assertManufacturingFeature} from './gate.ts';
import {manufacturingControlAccount,postManufacturingEntry} from './journal.ts';
import {holdWorkOrder} from './work-orders.ts';
import {auditChange,decimalValue} from './master-support.ts';
import {ManufacturingError,ManufacturingNotFoundError} from './errors.ts';
import {loadReceiptRework,receiptReworkIssuedQuantity,finishReceiptRework} from './receipt-rework.ts';

export interface ProductionLossInput {
  operationId:string;reasonId:string;quantity:string;reason:string;requestKey:string;
  times:Array<{operationId:string;attemptedQty:string;actualSetupMinutes:string;actualRunMinutes:string;actualLaborMinutes?:string|null}>;
}
function refuse(message:string,code:string,remedy:string):never {throw new ManufacturingError(message,{code,remedy,status:409})}
function normalize(input:ProductionLossInput) {
  if(!input||![input.operationId,input.reasonId,input.requestKey].every(isUuid)||!input.reason?.trim()||input.reason.trim().length<8||input.reason.trim().length>1000||!Array.isArray(input.times)||input.times.length>500) refuse('Choose an operation, loss reason and actual consumed time.','production_loss_input_required','Enter a reason of 8–1,000 characters and actual minutes for every started unfinished operation.');
  const times=input.times.map(row=>{
    if(!row||!isUuid(row.operationId))throw new ManufacturingNotFoundError();
    return {operationId:row.operationId,attemptedQty:decimalValue(row.attemptedQty,'attemptedQty','Enter the actual quantity attempted, including zero for setup-only work.'),actualSetupMinutes:decimalValue(row.actualSetupMinutes,'actualSetupMinutes','Enter non-negative actual minutes, including zero when no setup occurred.'),actualRunMinutes:decimalValue(row.actualRunMinutes,'actualRunMinutes','Enter non-negative actual run minutes, including zero when no running occurred.'),actualLaborMinutes:row.actualLaborMinutes==null?null:decimalValue(row.actualLaborMinutes,'actualLaborMinutes','Enter actual labor minutes or use configured approved employee time.')};
  }).sort((a,b)=>a.operationId.localeCompare(b.operationId));
  if(new Set(times.map(row=>row.operationId)).size!==times.length)refuse('Each operation needs one time record.','production_loss_times_duplicate','Remove the duplicate operation.');
  const quantity=decimalValue(input.quantity,'quantity','Enter the actual quantity discarded; unstarted work is cancelled separately.');if(cmp(quantity,'0')<=0)refuse('Loss quantity must be positive.','production_loss_quantity_required','Enter the quantity actually discarded.');
  return {...input,quantity,reason:input.reason.trim(),times};
}
async function snapshot(tx:SqlExecutor,orgId:string,workOrderId:string,input:ReturnType<typeof normalize>,onDate:string) {
  const order=(await tx.execute<ConversionOrder&{status:string;ordered:string;completed:string;scrapped:string}>(sql`select id,number,subsidiary_id,bom_revision,routing_version,status,quantity_ordered::text as quantity_ordered,quantity_ordered::text as ordered,quantity_completed::text as completed,quantity_scrapped::text as scrapped from mfg_work_orders where org_id=${orgId} and id=${workOrderId} for update`)).rows[0];
  if(!order||!order.subsidiary_id||!order.bom_revision||!order.routing_version)throw new ManufacturingNotFoundError();
  if(order.status!=='on_hold'||cmp(order.completed,'0')!==0||cmp(order.ordered,'0')<=0) refuse('A whole-order loss requires held work with no finished-goods receipts.','production_loss_order_not_ready','Hold the order and reverse any native completion receipts, newest first, before proposing the loss.');
  if((await tx.execute(sql`select id from mfg_work_orders where org_id=${orgId} and parent_wo_id=${workOrderId} and status not in('done','closed','cancelled') limit 1`)).rows.length) refuse('This order still has open subassembly work.','production_loss_children_open','Resolve its child work before proposing a whole-order disposition.');
  const operations=(await tx.execute<{id:string;sequence:number;status:string;quantity:string;scrapped:string;laborSource:string;actualSetup:string|null;actualRun:string|null;actualLabor:string|null}>(sql`select id,sequence,status,quantity_planned::text as quantity,quantity_scrapped_here::text as scrapped,labor_time_source as "laborSource",actual_setup_minutes::text as "actualSetup",actual_run_minutes::text as "actualRun",actual_labor_minutes::text as "actualLabor" from mfg_wo_operations where org_id=${orgId} and work_order_id=${workOrderId} order by id for update`)).rows;
  if(!operations.some(row=>row.id===input.operationId))throw new ManufacturingNotFoundError();
  const started=operations.filter(row=>['running','paused'].includes(row.status));
  if(input.times.length!==started.length||input.times.some(row=>!started.some(operation=>operation.id===row.operationId))) refuse('Actual time must cover every started unfinished operation.','production_loss_times_required','Record setup and run minutes for each started operation. Enter labor minutes unless it uses approved employee time.');
  if((await tx.execute(sql`select entry.id from time_entries entry join mfg_wo_operations operation on operation.org_id=entry.org_id and operation.id=entry.wo_operation_id where entry.org_id=${orgId} and entry.work_order_id=${workOrderId} and entry.production_consumed_operation_id is null and operation.status not in('running','paused') limit 1`)).rows.length) refuse('Employee time remains outside the loss operation set.','production_loss_unclaimed_time','Resolve time on completed or unstarted operations before closing this order.');
  const conversion=[];
  for(const operation of started) {
    const time=input.times.find(row=>row.operationId===operation.id)!;
    if(operation.laborSource==='approved_time'&&time.actualLaborMinutes!==null) refuse('This operation uses approved employee time.','production_loss_time_override','Leave its labor override blank and approve the shared employee records.');
    if(operation.laborSource!=='approved_time'&&time.actualLaborMinutes===null) refuse('Actual labor minutes are required for a loss.','production_loss_labor_required','Enter the minutes actually consumed, including zero for an unattended operation.');
    if(cmp(time.attemptedQty,operation.quantity)>0||cmp(time.attemptedQty,operation.scrapped)<0)refuse('Attempted quantity is outside the operation’s retained plan and scrap evidence.','production_loss_attempted_quantity_invalid','Enter the actual attempted quantity within its plan, including already recorded normal scrap.');
    conversion.push({operationId:operation.id,input:time,cost:await previewOperationConversion(tx,orgId,order,operation.id,time.attemptedQty,time,onDate)});
  }
  const contracts=(await tx.execute<{id:string;costRecorded:boolean}>(sql`select contract.id,exists(select 1 from mfg_subcontract_service_bills claim join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id and bill.status='posted' and bill.posted_entry_id=claim.source_entry_id join journal_entries source on source.org_id=claim.org_id and source.id=claim.source_entry_id and source.status='posted' left join journal_entries cost on cost.org_id=claim.org_id and cost.id=claim.capitalization_entry_id where claim.org_id=contract.org_id and claim.subcontract_id=contract.id and claim.reversal_entry_id is null and (claim.amount=0 or cost.status='posted')) as "costRecorded" from mfg_subcontracts contract where contract.org_id=${orgId} and contract.work_order_id=${workOrderId} and contract.status<>'cancelled' order by id for share of contract`)).rows;
  if(contracts.length) {
    await assertManufacturingFeature(tx,orgId,'manufacturingSubcontract');
    if(contracts.some(row=>!row.costRecorded))refuse('Vendor service cost remains unrecorded.','production_loss_vendor_cost_required','Post and record the dedicated service bill, including explicit zero-value service, before proposing the loss.');
    if((await tx.execute(sql`select layer.id from cost_layers layer join mfg_subcontract_shipments shipment on shipment.org_id=layer.org_id and shipment.to_movement_id=layer.source_movement_id join mfg_subcontracts contract on contract.org_id=shipment.org_id and contract.id=shipment.subcontract_id where contract.org_id=${orgId} and contract.work_order_id=${workOrderId} and layer.remaining_quantity>0 limit 1`)).rows.length) refuse('Unused components remain at a vendor.','production_loss_vendor_stock_remaining','Record actual consumption and return unused stock through the subcontract before closing this order.');
  }
  const reason=(await tx.execute<{id:string;name:string}>(sql`select id,name from mfg_scrap_reasons where org_id=${orgId} and id=${input.reasonId} and is_active and classification='abnormal' for share`)).rows[0];
  if(!reason)refuse('Choose an active abnormal-loss reason.','production_loss_reason_required','Configure or select an abnormal scrap reason in Manufacturing setup.');
  const wipAccountId=await manufacturingControlAccount(tx,orgId,order.subsidiary_id,'mfgWip');
  const profile=await resolveProfile(orgId,(await tx.execute<{item:string}>(sql`select produced_item_id as item from mfg_work_orders where org_id=${orgId} and id=${workOrderId}`)).rows[0]!.item,tx,true);
  if(!profile.varianceAccountId)refuse('The produced item has no loss or variance account.','production_loss_account_required','Configure its variance account in inventory costing setup.');
  const lossAccountId=profile.varianceAccountId;
  if(lossAccountId===wipAccountId)refuse('Loss and WIP must use different accounts.','production_loss_account_invalid','Choose a separate produced-item variance account.');
  await assertInventoryAccountsPostable(tx,orgId,[wipAccountId,lossAccountId]);
  const entries=(await tx.execute<{entryId:string;lineId:string;status:string;amount:string}>(sql`select entry.id as "entryId",line.id as "lineId",entry.status,line.amount::text from journal_entries entry join journal_lines line on line.org_id=entry.org_id and line.entry_id=entry.id where entry.org_id=${orgId} and entry.origin='manufacturing' and entry.custom->>'work_order_number'=${order.number} and entry.status in('posted','reversed') and line.account_id=${wipAccountId} order by entry.id,line.id for share of entry,line`)).rows;
  const wip=sum(entries.map(row=>row.amount));
  if(cmp(wip,'0')<0)refuse('This order has a credit WIP balance.','production_loss_negative_wip','Reconcile its native manufacturing entries before proposing a loss.');
  const remaining=add(order.ordered,neg(order.scrapped)),quantity=input.quantity;
  if(cmp(quantity,remaining)>0)refuse('Loss quantity exceeds the unaccounted order quantity.','production_loss_quantity_excess','Review prior scrap and enter only the actual remaining discarded quantity.');
  if(cmp(remaining,'0')<=0)refuse('No unaccounted output remains.','production_loss_quantity_exhausted','Review its existing scrap and disposition evidence.');
  const repair=await loadReceiptRework(tx,orgId,workOrderId);
  if(repair&&(cmp(quantity,remaining)!==0||cmp(order.ordered,repair.quantity)!==0||cmp(await receiptReworkIssuedQuantity(tx,orgId,workOrderId,repair),repair.quantity)!==0))
    refuse('A received-stock repair loss must account for all of its original inspected stock.','receipt_rework_loss_incomplete','Issue the full failed receipt into the repair, then dispose its remaining quantity. Use Quality’s scrap disposition when the original stock has not been issued.');
  const value=decimalValue(add(wip,sum(conversion.map(row=>row.cost.total))),'lossValue','Review the total WIP and actual conversion; the approved loss must fit supported accounting precision.');
  const unitCost=decimalValue(unitCostPerQuantity(value,quantity),'lossUnitCost','Review the discarded quantity and WIP value; the unit valuation must fit supported accounting precision.');
  return {order,operations,contracts,reason,wipAccountId,lossAccountId,entries,wip,conversion,quantity,value,unitCost,onDate,currency:await subsidiaryCurrency(orgId,order.subsidiary_id,tx)};
}

/** Stop execution while an immutable whole-order loss is independently approved. */
export async function proposeProductionLoss(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,raw:ProductionLossInput) {
  const input=normalize(raw);await assertManufacturingFeature(tx,orgId,'manufacturing');
  await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`financial-change:${orgId}:${input.requestKey}`}))`);
  const retained=(await tx.execute<{effective:string}>(sql`select effective_on::text as effective from financial_changes where org_id=${orgId} and idempotency_key=${input.requestKey}`)).rows[0];
  const onDate=retained?.effective??await businessTodayInTx(tx,orgId);
  const subject=(await tx.execute<{entity:string}>(sql`select subsidiary_id as entity from mfg_work_orders where org_id=${orgId} and id=${workOrderId}`)).rows[0];if(!subject)throw new ManufacturingNotFoundError();
  const proposal={orgId,actorId,subsidiaryId:subject.entity,domain:'manufacturing' as const,subjectId:workOrderId,operation:MANUFACTURING_LOSS_DISPOSITION_OPERATION,effectiveOn:onDate,reason:input.reason,idempotencyKey:input.requestKey,payload:{workOrderId,input,requiredSubsidiaryIds:[subject.entity]}};
  const prior=await existingFinancialChange(tx,proposal);if(prior)return {changeId:prior,approvalRequired:true};
  await holdWorkOrder(tx,orgId,actorId,workOrderId,input.reason);
  const beforeState=await snapshot(tx,orgId,workOrderId,input,onDate);
  return {changeId:await proposeFinancialChange(tx,{...proposal,beforeState}),approvalRequired:true};
}

/** No good-output receipt is invented: actual costs are recognized once and remaining WIP is expensed. */
export async function applyProductionLoss(orgId:string,actorId:string,changeId:string) {
  return withOrgTransaction(orgId,async()=>{
    await assertManufacturingFeature(db,orgId,'manufacturing');
    const change=await loadFinancialChange(db,orgId,changeId);
    if(change.domain!=='manufacturing'||change.operation!==MANUFACTURING_LOSS_DISPOSITION_OPERATION)throw new ManufacturingNotFoundError();
    await lockManufacturingOrderExecutionAuthority(db,orgId,actorId,change.subject_id);
    if(change.status==='applied') {if(!change.result)refuse('The disposition has no retained result.','production_loss_result_missing','Ask an administrator to inspect its native evidence.');return change.result;}
    const input=normalize(change.payload.input as ProductionLossInput);
    const before=await snapshot(db,orgId,change.subject_id,input,change.effective_on);
    assertFinancialChangeApproved(change,{domain:'manufacturing',subjectId:change.subject_id,beforeState:before});
    const conversionEntries=[];
    for(const line of before.conversion) {
      const operation=before.operations.find(row=>row.id===line.operationId)!;
      const result=await absorbOperationConversion(db,orgId,actorId,before.order,line.operationId,line.input.attemptedQty,line.input,{onDate:change.effective_on});conversionEntries.push(result.entryId);
      if((await db.execute(sql`update mfg_wo_operations set status='paused',pause_reason=${change.reason},actual_setup_minutes=${result.setupMinutes},actual_run_minutes=${result.runMinutes},actual_labor_minutes=${result.laborMinutes},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${line.operationId} and work_order_id=${change.subject_id} and status in('running','paused') returning id`)).rows.length!==1)refuse('The operation changed during disposition.','production_loss_write_failed','Reload and propose against its current evidence.');
      await auditChange(db,{orgId,actorId,table:'mfg_wo_operations',rowId:line.operationId,action:'update',before:operation,after:{...operation,status:'paused',actualSetupMinutes:result.setupMinutes,actualRunMinutes:result.runMinutes,actualLaborMinutes:result.laborMinutes,conversionEntryId:result.entryId,lossChangeId:changeId}});
    }
    const periodId=await periodForDate(orgId,change.effective_on,db);if(!periodId)refuse('No period covers the disposition date.','production_loss_period_required','Open the accounting period for the approved loss date.');
    const eventId=randomUUID();
    const entryId=cmp(before.value,'0')===0?null:await postManufacturingEntry(db,{orgId,actorId,bookId:await primaryBookId(orgId,db),subsidiaryId:before.order.subsidiary_id!,currency:before.currency,periodId,date:change.effective_on,entryNumber:`MFG-LOSS-${eventId}`,memo:`${before.order.number} whole-order loss`,lines:[{accountId:before.lossAccountId,amount:before.value},{accountId:before.wipAccountId,amount:neg(before.value)}],custom:{workOrderNumber:before.order.number,bomRevision:before.order.bom_revision!,routingVersion:String(before.order.routing_version),loss_change_id:changeId,scrap_event_id:eventId,loss_quantity:before.quantity,loss_value:before.value}});
    if((await db.execute(sql`insert into mfg_scrap_events(id,org_id,work_order_id,operation_id,quantity,reason_id,classification,treatment,frozen_value,frozen_unit_cost,approval_required,posted_entry_id,disposition_change_id,created_by,updated_by) values(${eventId},${orgId},${change.subject_id},${input.operationId},${before.quantity},${input.reasonId},'abnormal','operation',${before.value},${before.unitCost},true,${entryId},${changeId},${actorId},${actorId}) returning id`)).rows.length!==1)refuse('Loss evidence was not recorded.','production_loss_write_failed','Retry; no cost or quantity was posted.');
    if((await db.execute(sql`update mfg_work_orders set status='cancelled',cancel_reason=${change.reason},hold_reason=null,hold_prior_status=null,quantity_scrapped=quantity_scrapped+${before.quantity}::numeric,loss_change_id=${changeId},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${change.subject_id} and status='on_hold' and quantity_completed=0 returning id`)).rows.length!==1)refuse('The order changed during loss disposition.','production_loss_write_failed','Reload and propose against its current evidence.');
    const result={workOrderId:change.subject_id,eventId,entryId,conversionEntries,quantity:before.quantity,value:before.value,status:'cancelled'};
    await auditChange(db,{orgId,actorId,table:'mfg_scrap_events',rowId:eventId,action:'insert',before:null,after:{...result,dispositionChangeId:changeId,reasonId:input.reasonId}});
    await auditChange(db,{orgId,actorId,table:'mfg_work_orders',rowId:change.subject_id,action:'update',before:before.order,after:{...result,quantityScrapped:add(before.order.scrapped,before.quantity),reason:change.reason,lossChangeId:changeId}});
    await completeFinancialChange(db,orgId,changeId,actorId,result);
    await finishReceiptRework(db,orgId,actorId,change.subject_id,'loss');
    return result;
  });
}
