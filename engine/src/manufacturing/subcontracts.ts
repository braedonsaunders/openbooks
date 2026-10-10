import { startWorkOrderOperation } from "./work-orders.ts";
import { completeWorkOrderOperation,consumeSubcontractMaterials,type OperationCompletion } from "./materials.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { fromUnits,toUnits,cmp,sum,neg } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { businessToday } from "../platform/business-date.ts";
import { getOnHandWith,periodForDate,subsidiaryCurrency,primaryBookId } from "../inventory/position.ts";
import { reverseInventoryJournal } from "../inventory/reversal.ts";
import { manufacturingControlAccount,postManufacturingEntry } from "./journal.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { subcontractServiceResourcesVisible,documentResourcesVisible,pinProductionDocumentResources } from "../organization/production-resource-scope.ts";
import { assertSaleableStock } from "../inventory/stock-eligibility.ts";
import { transferInventoryTx } from "../inventory/transfers.ts";
import { lockSubcontractCustodyAuthority } from "../inventory/subcontract-custody.ts";
import { assertInspectionIdentifierScope } from "../inventory/inspections.ts";
import { lockManufacturingOrderExecutionAuthority } from "./authority.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError,ManufacturingNotFoundError,ManufacturingIdempotencyConflictError } from "./errors.ts";
import { auditChange,decimalValue,isoDate } from "./master-support.ts";

type Contract={id:string;workOrderId:string;operationId:string;vendorId:string;custodyLocationId:string;quantityExpected:string;status:string;requestSnapshot:Record<string,unknown>};
const contractColumns=sql`id,work_order_id as "workOrderId",operation_id as "operationId",vendor_id as "vendorId",custody_location_id as "custodyLocationId",quantity_expected::text as "quantityExpected",status,request_snapshot as "requestSnapshot"`;
const refuse=(message:string,code:string,remedy:string):never=>{throw new ManufacturingError(message,{status:409,code,remedy});};
const identifiers=(ids:unknown[])=>{if(ids.some(id=>typeof id!=="string"||!isUuid(id))) throw new ManufacturingNotFoundError();};

async function lockSubcontract(tx:SqlExecutor,orgId:string,actorId:string,id:string) {
  identifiers([id]);
  await assertManufacturingFeature(tx,orgId,"manufacturingSubcontract");
  const subject=(await tx.execute<Contract>(sql`select ${contractColumns} from mfg_subcontracts where org_id=${orgId} and id=${id}`)).rows[0];
  if(!subject) throw new ManufacturingNotFoundError();
  const scope=await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,subject.workOrderId,null,subject.custodyLocationId);
  const order=(await tx.execute<{id:string;subsidiaryId:string;status:string}>(sql`select id,subsidiary_id as "subsidiaryId",status from mfg_work_orders where org_id=${orgId} and id=${subject.workOrderId} for update`)).rows[0];
  if(!order) throw new ManufacturingNotFoundError();
  const custody=await lockSubcontractCustodyAuthority(tx,orgId,actorId,order.subsidiaryId,subject.custodyLocationId);
  if(!custody || custody.vendorId!==subject.vendorId) throw new ManufacturingNotFoundError();
  const record=(await tx.execute<Contract>(sql`select ${contractColumns} from mfg_subcontracts where org_id=${orgId} and id=${id} for update`)).rows[0];
  if(!record) throw new ManufacturingNotFoundError();
  return {record,order,scope};
}

export interface CreateProductionSubcontract {id:string;workOrderId:string;operationId:string;vendorId:string;custodyLocationId:string}

/** The operation stays on its original work order, including its released revision and costs. */
export async function createProductionSubcontract(tx:SqlExecutor,orgId:string,actorId:string,input:CreateProductionSubcontract) {
  identifiers([input.id,input.workOrderId,input.operationId,input.vendorId,input.custodyLocationId]);
  await assertManufacturingFeature(tx,orgId,"manufacturingSubcontract");
  await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,input.workOrderId,null,input.custodyLocationId);
  const order=(await tx.execute<{subsidiaryId:string;status:string}>(sql`select subsidiary_id as "subsidiaryId",status from mfg_work_orders where org_id=${orgId} and id=${input.workOrderId} for update`)).rows[0];
  if(!order) throw new ManufacturingNotFoundError();
  const custody=await lockSubcontractCustodyAuthority(tx,orgId,actorId,order.subsidiaryId,input.custodyLocationId);
  if(!custody||custody.vendorId!==input.vendorId) refuse("The vendor and custody location must agree.","subcontract_vendor_location_mismatch","Choose the selected vendor's company-owned custody location.");
  const existing=(await tx.execute<Contract>(sql`select ${contractColumns} from mfg_subcontracts where org_id=${orgId} and id=${input.id} for update`)).rows[0];
  if(existing) {
    if(canonicalJson(existing.requestSnapshot)!==canonicalJson(input)) throw new ManufacturingIdempotencyConflictError();
    return {...existing,replayed:true};
  }
  if(!['released','in_progress'].includes(order.status)) refuse("Subcontracting requires an open released order.","subcontract_order_not_open","Release or resume the work order before assigning an operation to a vendor.");
  if((await tx.execute(sql`select entry.id from journal_entries entry join mfg_work_orders work on work.org_id=entry.org_id and work.number=entry.custom->>'work_order_number'
    where work.org_id=${orgId} and work.id=${input.workOrderId} and entry.origin='manufacturing' and entry.status='posted' and entry.reverses_entry_id is null and entry.custom ? 'completion_quantity' limit 1`)).rows.length)
    refuse('This order already has finished-goods receipts.','subcontract_after_receipt','Reverse its native completion receipts before assigning an unfinished operation to a vendor.');
  const operation=(await tx.execute<{quantity:string;status:string;backflushAt:string}>(sql`select quantity_planned::text as quantity,status,backflush_at as "backflushAt" from mfg_wo_operations
    where org_id=${orgId} and work_order_id=${input.workOrderId} and id=${input.operationId} for update`)).rows[0];
  if(!operation) throw new ManufacturingNotFoundError();
  if(!['pending','running'].includes(operation.status)||cmp(operation.quantity,'0')<=0) refuse("This operation cannot be assigned to a vendor.","subcontract_operation_not_open","Choose an unfinished operation with positive planned quantity.");
  if(operation.backflushAt!=='none') refuse("This operation automatically issues components at the shop.","subcontract_backflush_conflict","Use a routing revision with manual material issue for the vendor operation; released orders retain their original routing.");
  if((await tx.execute(sql`select id from mfg_subcontracts where org_id=${orgId} and operation_id=${input.operationId} and status<>'cancelled' limit 1`)).rows.length) refuse("This operation already has a production subcontract.","subcontract_operation_assigned","Open its existing subcontract to send components or receive the work.");
  const saved=(await tx.execute<Contract>(sql`insert into mfg_subcontracts(id,org_id,work_order_id,operation_id,vendor_id,custody_location_id,quantity_expected,request_snapshot,created_by,updated_by)
    values(${input.id},${orgId},${input.workOrderId},${input.operationId},${input.vendorId},${input.custodyLocationId},${operation.quantity},${JSON.stringify(input)}::jsonb,${actorId},${actorId}) returning ${contractColumns}`)).rows[0];
  if(!saved) refuse("The production subcontract was not saved.","subcontract_write_failed","Reload the operation and retry; nothing was assigned.");
  await auditChange(tx,{orgId,actorId,table:"mfg_subcontracts",rowId:saved.id,action:"insert",before:null,after:saved,requestId:input.id});
  return {...saved,replayed:false};
}

export interface ShipSubcontractMaterial {id:string;materialId:string;sourceLocationId:string;quantity:string;date:string;lotId?:string|null;serialId?:string|null}

/** Shipping is a native valued transfer; material expense enters WIP only when the vendor consumes it. */
export async function shipSubcontractMaterial(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,raw:ShipSubcontractMaterial) {
  identifiers([raw.id,raw.materialId,raw.sourceLocationId,...[raw.lotId,raw.serialId].filter(id=>id!=null)]);
  const quantity=fromUnits(toUnits(decimalValue(raw.quantity,"quantity","Enter a positive component quantity.")));
  if(cmp(quantity,'0')<=0) refuse("Send a positive component quantity.","subcontract_quantity_invalid","Enter the quantity being sent to the vendor.");
  const input={...raw,quantity,date:isoDate(raw.date,"date"),lotId:raw.lotId??null,serialId:raw.serialId??null};
  const {record,order,scope}=await lockSubcontract(tx,orgId,actorId,contractId);
  const source=(await tx.execute(sql`select stock.id from stock_locations stock join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where stock.org_id=${orgId} and stock.id=${input.sourceLocationId} ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}`)).rows[0];
  if(!source) throw new ManufacturingNotFoundError();
  const existing=(await tx.execute<{requestSnapshot:Record<string,unknown>;fromMovementId:string;toMovementId:string;value:string}>(sql`select request_snapshot as "requestSnapshot",from_movement_id as "fromMovementId",to_movement_id as "toMovementId",value::text from mfg_subcontract_shipments where org_id=${orgId} and id=${input.id} for update`)).rows[0];
  if(existing) {
    if(canonicalJson(existing.requestSnapshot)!==canonicalJson({...input,subcontractId:contractId})) throw new ManufacturingIdempotencyConflictError();
    return {id:input.id,fromMovementId:existing.fromMovementId,toMovementId:existing.toMovementId,value:existing.value,replayed:true};
  }
  if(!['ready','sent'].includes(record.status)||!['released','in_progress'].includes(order.status)) refuse("This subcontract is not open for component shipments.","subcontract_not_open","Resume the order or use the open subcontract for this operation.");
  const material=(await tx.execute<{itemId:string;required:string;issued:string;sequence:number|null;operationSequence:number;operationStatus:string}>(sql`select material.component_item_id as "itemId",material.required_qty::text as required,(material.issued_qty+material.backflush_qty)::text as issued,material.operation_seq as sequence,operation.sequence as "operationSequence",operation.status as "operationStatus"
    from mfg_wo_materials material join mfg_wo_operations operation on operation.org_id=material.org_id and operation.work_order_id=material.work_order_id and operation.id=${record.operationId}
    where material.org_id=${orgId} and material.work_order_id=${record.workOrderId} and material.id=${input.materialId} for update of material,operation`)).rows[0];
  if(!material) throw new ManufacturingNotFoundError();
  if(material.sequence!=null&&material.sequence!==material.operationSequence) refuse("This component belongs to another operation.","subcontract_material_operation_mismatch","Send a component assigned to this operation or an unassigned order component.");
  if(!['pending','running'].includes(material.operationStatus)) refuse("The vendor operation is not open for shipping.","subcontract_operation_not_open","Resume the operation before sending components.");
  const outstanding=(await tx.execute<{quantity:string}>(sql`select coalesce(sum(layer.remaining_quantity),0)::text as quantity
    from mfg_subcontract_shipments shipment join mfg_subcontracts contract on contract.org_id=shipment.org_id and contract.id=shipment.subcontract_id
    join cost_layers layer on layer.org_id=shipment.org_id and layer.source_movement_id=shipment.to_movement_id
    where shipment.org_id=${orgId} and shipment.material_id=${input.materialId} and contract.status<>'cancelled'`)).rows[0]!.quantity;
  if(toUnits(quantity)+toUnits(outstanding)+toUnits(material.issued)>toUnits(material.required)) refuse("The sent quantity exceeds the order's remaining component requirement.","subcontract_material_excess","Review issued components and stock already at vendors; send only the remaining requirement.");
  await assertInspectionIdentifierScope(tx,orgId,actorId,material.itemId,scope,input);
  await assertSaleableStock(tx,orgId,input.sourceLocationId,input);
  const moved=await transferInventoryTx(tx,orgId,actorId,{itemId:material.itemId,fromStockLocationId:input.sourceLocationId,toStockLocationId:record.custodyLocationId,quantity,lotId:input.lotId,serialId:input.serialId,subsidiaryId:order.subsidiaryId,date:input.date,memo:`Production subcontract ${record.id} component shipment`});
  const snapshot={...input,subcontractId:contractId};
  const inserted=await tx.execute(sql`insert into mfg_subcontract_shipments(id,org_id,subcontract_id,material_id,source_location_id,quantity,value,from_movement_id,to_movement_id,request_snapshot,created_by,updated_by)
    values(${input.id},${orgId},${contractId},${input.materialId},${input.sourceLocationId},${quantity},${moved.value},${moved.fromMovementId},${moved.toMovementId},${JSON.stringify(snapshot)}::jsonb,${actorId},${actorId}) returning id`);
  if(inserted.rows.length!==1) refuse("The component shipment was not recorded.","subcontract_write_failed","Reload the subcontract and retry; nothing was sent.");
  if(record.status==='ready'&&(await tx.execute(sql`update mfg_subcontracts set status='sent',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${contractId} and status='ready' returning id`)).rows.length!==1) refuse("The subcontract changed during shipment.","subcontract_write_failed","Reload and retry; nothing was sent.");
  await auditChange(tx,{orgId,actorId,table:"mfg_subcontract_shipments",rowId:input.id,action:"insert",before:null,after:{...snapshot,...moved},requestId:input.id});
  if(record.status==='ready') await auditChange(tx,{orgId,actorId,table:"mfg_subcontracts",rowId:contractId,action:"update",before:record,after:{...record,status:'sent'}});
  return {id:input.id,...moved,replayed:false};
}

/** Capitalize a dedicated posted service bill from its immutable functional-currency expense lines. */
export async function capitalizeSubcontractServiceBill(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,billId:string,requestKey:string) {
  identifiers([billId,requestKey]);
  const {record,order,scope:productionScope}=await lockSubcontract(tx,orgId,actorId,contractId);
  const apScope=await lockActorCommandAuthority(tx,orgId,actorId,order.subsidiaryId,'ap.post');
  const scope=apScope===null?productionScope:productionScope===null?apScope:new Set([...productionScope].filter(id=>apScope.has(id)));
  if(!(await tx.execute<{visible:boolean}>(sql`select ${subcontractServiceResourcesVisible(scope,sql`${orgId}`,sql`${record.workOrderId}::uuid`)} as visible`)).rows[0]?.visible)throw new ManufacturingNotFoundError();
  await pinProductionDocumentResources(tx,orgId,billId);
  if(!(await tx.execute(sql`select document.id from documents document where document.org_id=${orgId} and document.id=${billId}
    ${subsidiaryVisibleFilter(sql`document.subsidiary_id`,scope)} and ${documentResourcesVisible(scope,'document')}`)).rows.length)throw new ManufacturingNotFoundError();
  const existing=(await tx.execute<{id:string;subcontractId:string;billId:string;entryId:string|null;amount:string}>(sql`select id,subcontract_id as "subcontractId",bill_id as "billId",capitalization_entry_id as "entryId",amount::text from mfg_subcontract_service_bills where org_id=${orgId} and id=${requestKey} for share`)).rows[0];
  if(existing) {
    if(existing.subcontractId!==contractId||existing.billId!==billId) throw new ManufacturingIdempotencyConflictError();
    return {...existing,replayed:true};
  }
  if(!['ready','sent','received'].includes(record.status)||!['released','in_progress'].includes(order.status)) refuse('This subcontract is not open for service cost.','subcontract_not_open','Resume the work order before recording its vendor service cost.');
  if((await tx.execute(sql`select id from inventory_movements where org_id=${orgId} and kind='assembly_build' and journal_entry_id in
    (select id from journal_entries where org_id=${orgId} and origin='manufacturing' and custom->>'work_order_number'=(select number from mfg_work_orders where org_id=${orgId} and id=${record.workOrderId}) and status='posted' and reverses_entry_id is null) limit 1`)).rows.length) refuse('Finished goods have already been received for this order.','subcontract_service_after_receipt','Reverse the order’s completion receipts through their native reversal action before adding an omitted service bill.');
  const bill=(await tx.execute<{entryId:string;bookId:string;postingDate:string;number:string}>(sql`select entry.id as "entryId",entry.book_id as "bookId",entry.posting_date::text as "postingDate",document.document_number as number
    from documents document join journal_entries entry on entry.org_id=document.org_id and entry.id=document.posted_entry_id and entry.source_document_id=document.id
    where document.org_id=${orgId} and document.id=${billId} and document.kind='vendor_bill' and document.status='posted'
      and document.party_id=${record.vendorId} and document.subsidiary_id=${order.subsidiaryId} and entry.subsidiary_id=${order.subsidiaryId}
      and entry.status='posted' and entry.reverses_entry_id is null
      and not exists(select 1 from journal_entries reversal where reversal.org_id=entry.org_id and reversal.reverses_entry_id=entry.id and reversal.status='posted')
    for update of document,entry`)).rows[0];
  if(!bill) refuse('Use this vendor’s posted service bill in the work order’s legal entity.','subcontract_service_bill_required','Post the service bill through Payables, then record its service cost on this subcontract.');
  await tx.execute(sql`select line.id from journal_lines line where line.org_id=${orgId} and line.entry_id=${bill.entryId} order by line.id for share`);
  await tx.execute(sql`select department.id from departments department where department.org_id=${orgId} and department.id in(select department_id from journal_lines where org_id=${orgId} and entry_id=${bill.entryId}) order by department.id for share`);
  await tx.execute(sql`select location.id from locations location where location.org_id=${orgId} and location.id in(select location_id from journal_lines where org_id=${orgId} and entry_id=${bill.entryId}) order by location.id for share`);
  await tx.execute(sql`select party.id from parties party where party.org_id=${orgId} and party.id in(select party_id from journal_lines where org_id=${orgId} and entry_id=${bill.entryId}) order by party.id for share`);
  if(bill.bookId!==await primaryBookId(orgId,tx)) refuse('The service bill does not use the production posting book.','subcontract_service_book_mismatch','Use a service bill posted in the company’s primary production book.');
  if((await tx.execute(sql`select id from document_lines where org_id=${orgId} and document_id=${billId}
    and (project_id is not null or (party_id is not null and party_id<>${record.vendorId}) or (item_id is not null and exists(select 1 from item_inventory_profiles profile where profile.org_id=${orgId} and profile.item_id=document_lines.item_id))) limit 1`)).rows.length) refuse('This bill also carries project work, other parties or stocked items.','subcontract_service_bill_mixed','Use a dedicated service bill for this production operation; project subcontracts and stock purchases retain their own costing.');
  if((await tx.execute(sql`select id from mfg_subcontract_service_bills where org_id=${orgId} and bill_id=${billId} and reversal_entry_id is null limit 1`)).rows.length) refuse('This bill already has active production service-cost evidence.','subcontract_service_bill_used','Open its existing service cost; reverse that capitalization before assigning the same bill again.');
  const costs=(await tx.execute<{accountId:string;amount:string;departmentId:string|null;locationId:string|null}>(sql`select line.account_id as "accountId",line.amount::text,line.department_id as "departmentId",line.location_id as "locationId"
    from journal_lines line join accounts account on account.org_id=line.org_id and account.id=line.account_id
    where line.org_id=${orgId} and line.entry_id=${bill.entryId} and account.type in('cogs','expense','expense_other') order by line.line_number for share of line,account`)).rows;
  const amount=sum(costs.map(line=>line.amount));
  if(!costs.length||cmp(amount,'0')<0) refuse('The posted bill has no non-negative production service expense to capitalize.','subcontract_service_expense_required','Post the operation’s service charge to a native expense account on its dedicated vendor bill.');
  if((await tx.execute(sql`select id from journal_lines where org_id=${orgId} and entry_id=${bill.entryId} and (subsidiary_id<>${order.subsidiaryId} or project_id is not null) limit 1`)).rows.length) throw new ManufacturingNotFoundError();
  if((await tx.execute(sql`select line.id from journal_lines line
    left join departments department on department.org_id=line.org_id and department.id=line.department_id
    left join locations location on location.org_id=line.org_id and location.id=line.location_id
    left join parties party on party.org_id=line.org_id and party.id=line.party_id
    where line.org_id=${orgId} and line.entry_id=${bill.entryId}
      and ((line.department_id is not null and (department.id is null or not(true ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})})))
        or (line.location_id is not null and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})})))
        or (line.party_id is not null and (party.id is null or not(true ${subsidiaryVisibleFilter(sql`party.subsidiary_id`,scope,{orgWideNull:true})})))) limit 1`)).rows.length) throw new ManufacturingNotFoundError();
  const released=(await tx.execute<{number:string;bomRevision:string;routingVersion:number}>(sql`select number,bom_revision as "bomRevision",routing_version as "routingVersion" from mfg_work_orders where org_id=${orgId} and id=${record.workOrderId}`)).rows[0]!;
  const date=await businessToday(orgId),periodId=await periodForDate(orgId,date,tx);
  if(!periodId) refuse('No accounting period covers the service capitalization date.','subcontract_service_period_missing','Open the accounting period before recording vendor service cost.');
  const wip=await manufacturingControlAccount(tx,orgId,order.subsidiaryId,'mfgWip');
  const entryId=cmp(amount,'0')===0?null:await postManufacturingEntry(tx,{orgId,actorId,bookId:bill.bookId,subsidiaryId:order.subsidiaryId,currency:await subsidiaryCurrency(orgId,order.subsidiaryId,tx),periodId,date,entryNumber:`MFG-SERVICE-${randomUUID()}`,memo:`${released.number} vendor service ${bill.number}`,
    lines:[{accountId:wip,amount,memo:`${released.number} outsourced conversion`},...costs.map(line=>({...line,amount:neg(line.amount),memo:`${bill.number} service expense capitalized`}))],
    custom:{workOrderNumber:released.number,bomRevision:released.bomRevision,routingVersion:String(released.routingVersion),subcontract_id:contractId,subcontract_service_bill_id:billId,subcontract_service_claim_id:requestKey,source_bill_entry_id:bill.entryId,source_expenses:costs}});
  const written=await tx.execute(sql`insert into mfg_subcontract_service_bills(id,org_id,subcontract_id,bill_id,source_entry_id,capitalization_entry_id,wip_account_id,amount,expense_snapshot,created_by,updated_by)
    values(${requestKey},${orgId},${contractId},${billId},${bill.entryId},${entryId},${wip},${amount},${JSON.stringify(costs)}::jsonb,${actorId},${actorId}) returning id`);
  if(written.rows.length!==1) refuse('The vendor service cost was not recorded.','subcontract_write_failed','Reload and retry; neither costing nor the bill changed.');
  await auditChange(tx,{orgId,actorId,table:'mfg_subcontract_service_bills',rowId:requestKey,action:'insert',before:null,after:{subcontractId:contractId,billId,sourceEntryId:bill.entryId,entryId,amount,expenses:costs},requestId:requestKey});
  return {id:requestKey,subcontractId:contractId,billId,entryId,amount,replayed:false};
}

/** Unreceived service cost reverses through the same native journal correction as production receipts. */
export async function reverseSubcontractServiceCost(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,claimId:string,date:string,reason:string) {
  identifiers([claimId]);isoDate(date,'date');
  if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>500) refuse('Explain the service-cost correction.','subcontract_correction_reason_required','Enter a reason between five and five hundred characters.');
  const {record,order,scope:productionScope}=await lockSubcontract(tx,orgId,actorId,contractId);
  const apScope=await lockActorCommandAuthority(tx,orgId,actorId,order.subsidiaryId,'ap.post');
  const scope=apScope===null?productionScope:productionScope===null?apScope:new Set([...productionScope].filter(id=>apScope.has(id)));
  if(!(await tx.execute<{visible:boolean}>(sql`select ${subcontractServiceResourcesVisible(scope,sql`${orgId}`,sql`${record.workOrderId}::uuid`)} as visible`)).rows[0]?.visible)throw new ManufacturingNotFoundError();
  const claim=(await tx.execute<{entryId:string|null;reversalId:string|null;reversalReason:string|null;reversalDate:string|null}>(sql`select claim.capitalization_entry_id as "entryId",claim.reversal_entry_id as "reversalId",claim.reversal_reason as "reversalReason",entry.posting_date::text as "reversalDate"
    from mfg_subcontract_service_bills claim left join journal_entries entry on entry.org_id=claim.org_id and entry.id=claim.reversal_entry_id where claim.org_id=${orgId} and claim.id=${claimId} and claim.subcontract_id=${contractId} for update of claim`)).rows[0];
  if(!claim) throw new ManufacturingNotFoundError();
  if(claim.reversalId) {
    if(claim.reversalDate!==date||claim.reversalReason!==reason.trim()) throw new ManufacturingIdempotencyConflictError();
    return {id:claimId,entryId:claim.reversalId,replayed:true};
  }
  if(!['released','in_progress','on_hold'].includes(order.status)) refuse('This service belongs to a closed work order.','subcontract_service_already_received','Use the work order’s governed completion reversal before correcting its service cost.');
  if(!claim.entryId) refuse('This service bill carried no capitalized value.','subcontract_zero_cost_correction','Correct the zero-value bill through Payables; the retained production evidence has no journal to reverse.');
  if((await tx.execute(sql`select entry.id from journal_entries entry where entry.org_id=${orgId} and entry.origin='manufacturing' and entry.custom->>'work_order_number'=(select number from mfg_work_orders where org_id=${orgId} and id=${record.workOrderId}) and entry.status='posted' and entry.reverses_entry_id is null and entry.custom ? 'completion_quantity' limit 1`)).rows.length) refuse('Finished goods have already been received for this order.','subcontract_service_after_receipt','Reverse the order’s native completion receipts before reversing its service cost.');
  const entryId=await reverseInventoryJournal(tx,orgId,actorId,claim.entryId,date,reason.trim(),{allowManufacturingOrigin:true});
  if((await tx.execute(sql`update mfg_subcontract_service_bills set reversal_entry_id=${entryId},reversal_reason=${reason.trim()},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${claimId} and reversal_entry_id is null returning id`)).rows.length!==1) refuse('The service-cost reversal was not recorded.','subcontract_write_failed','Reload and retry; nothing was reversed.');
  await auditChange(tx,{orgId,actorId,table:'mfg_subcontract_service_bills',rowId:claimId,action:'update',before:claim,after:{entryId:claim.entryId,reversalEntryId:entryId,reason:reason.trim()}});
  return {id:claimId,entryId,replayed:false};
}


export interface SubcontractReturnInput {
  id:string;quantity:string;finish:boolean;finishReason?:string|null;
  consumption?:Array<{shipmentId:string;quantity:string}>;
  measuredQty?:string|null;actualSetupMinutes?:string|null;actualRunMinutes?:string|null;actualLaborMinutes?:string|null;
}

/** Partial deliveries are progress; the final delivery closes the native operation with its real costs. */
export async function recordSubcontractReturn(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,input:SubcontractReturnInput) {
  if(!input||typeof input.finish!=='boolean') refuse('Choose whether this is the final vendor delivery.','subcontract_return_invalid','Record the returned quantity and choose Final delivery only when the vendor operation is finished.');
  identifiers([input.id]);
  const quantity=fromUnits(toUnits(decimalValue(input.quantity,'quantity','Enter a positive quantity actually returned by the vendor.')));
  if(cmp(quantity,'0')<=0) refuse('Returned quantity must be positive.','subcontract_return_invalid','Record an actual delivery; record losses through the work order’s scrap action.');
  const reason=input.finishReason?.trim()||null;
  if(reason!==null&&(reason.length<5||reason.length>500)) refuse('The finish reason must contain 5–500 characters.','subcontract_finish_reason_invalid','Explain why the vendor finished below the expected quantity.');
  if(input.consumption!==undefined&&(!Array.isArray(input.consumption)||input.consumption.length>100||input.consumption.some(line=>!line||typeof line!=='object'||!isUuid(line.shipmentId)))) refuse('Select actual component shipments for this delivery.','subcontract_consumption_invalid','Choose the shipment and the exact quantity used; leave consumption empty when already recorded.');
  const consumption=input.consumption?.map(line=>({shipmentId:line.shipmentId,quantity:fromUnits(toUnits(decimalValue(line.quantity,'quantity','Enter the component quantity used by the vendor.')))})).sort((a,b)=>a.shipmentId.localeCompare(b.shipmentId))??[];
  const snapshot={...input,subcontractId:contractId,quantity,finishReason:reason,consumption};
  const {record,order}=await lockSubcontract(tx,orgId,actorId,contractId);
  const prior=(await tx.execute<{requestSnapshot:unknown}>(sql`select request_snapshot as "requestSnapshot" from mfg_subcontract_returns where org_id=${orgId} and id=${input.id} for share`)).rows[0];
  if(prior) {
    if(canonicalJson(prior.requestSnapshot)!==canonicalJson(snapshot)) throw new ManufacturingIdempotencyConflictError();
    const total=(await tx.execute<{quantity:string}>(sql`select coalesce(sum(quantity),0)::text as quantity from mfg_subcontract_returns where org_id=${orgId} and subcontract_id=${contractId}`)).rows[0]!.quantity;
    return {id:input.id,quantityReturned:total,status:record.status,replayed:true};
  }
  if(!['ready','sent'].includes(record.status)||!['released','in_progress'].includes(order.status)) refuse('This subcontract is not open for a delivery.','subcontract_not_open','Resume the order and record the delivery against its open vendor operation.');
  const operation=(await tx.execute<{status:string;scrapped:string}>(sql`select status,quantity_scrapped_here::text as scrapped from mfg_wo_operations where org_id=${orgId} and work_order_id=${record.workOrderId} and id=${record.operationId} for update`)).rows[0];
  if(!operation) throw new ManufacturingNotFoundError();
  if(!['pending','running'].includes(operation.status)) refuse('The vendor operation cannot receive this delivery.','subcontract_operation_not_open','Resume its paused operation before recording the delivery.');
  const priorQuantity=(await tx.execute<{quantity:string}>(sql`select coalesce(sum(quantity),0)::text as quantity from mfg_subcontract_returns where org_id=${orgId} and subcontract_id=${contractId}`)).rows[0]!.quantity;
  const total=fromUnits(toUnits(priorQuantity)+toUnits(quantity));
  const accounted=toUnits(total)+toUnits(operation.scrapped);
  if(accounted>toUnits(record.quantityExpected)) refuse('Returned goods and recorded operation scrap exceed the expected quantity.','subcontract_return_excess','Review prior deliveries and scrap; record only the vendor’s remaining actual quantity.');
  if(input.finish&&accounted<toUnits(record.quantityExpected)&&!reason) refuse('Finishing below the expected quantity requires a reason.','subcontract_finish_reason_required','Explain the shortage; the work order retains its original ordered quantity.');
  if(input.finish&&!(await tx.execute(sql`select claim.id from mfg_subcontract_service_bills claim
    join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id and bill.status='posted' and bill.posted_entry_id=claim.source_entry_id
    join journal_entries source on source.org_id=claim.org_id and source.id=claim.source_entry_id and source.status='posted'
    left join journal_entries cost on cost.org_id=claim.org_id and cost.id=claim.capitalization_entry_id
    where claim.org_id=${orgId} and claim.subcontract_id=${contractId} and claim.reversal_entry_id is null
      and (claim.amount=0 or cost.status='posted') for share of claim,bill,source`)).rows.length)
    refuse('The vendor service bill has not been recorded in this order’s WIP.','subcontract_service_cost_required','Post the dedicated service bill in Purchasing, then record its service cost on this subcontract. An explicit zero-value bill records a free service.');
  if(operation.status==='pending') await startWorkOrderOperation(tx,orgId,actorId,record.workOrderId,record.operationId);
  if(consumption.length) await consumeSubcontractMaterials(tx,orgId,actorId,contractId,input.id,consumption);
  const inserted=await tx.execute(sql`insert into mfg_subcontract_returns(id,org_id,subcontract_id,quantity,request_snapshot,finish_reason,created_by,updated_by)
    values(${input.id},${orgId},${contractId},${quantity},${JSON.stringify(snapshot)}::jsonb,${reason},${actorId},${actorId}) returning id`);
  if(inserted.rows.length!==1) refuse('The vendor delivery was not recorded.','subcontract_write_failed','Reload and retry; no quantity or cost was posted.');
  await auditChange(tx,{orgId,actorId,table:'mfg_subcontract_returns',rowId:input.id,action:'insert',before:null,after:snapshot,requestId:input.id});
  if(input.finish) {
    const completion:OperationCompletion={doneQty:total,measuredQty:input.measuredQty,actualSetupMinutes:input.actualSetupMinutes,actualRunMinutes:input.actualRunMinutes,actualLaborMinutes:input.actualLaborMinutes};
    await completeWorkOrderOperation(tx,orgId,actorId,record.workOrderId,record.operationId,completion);
    if((await tx.execute(sql`update mfg_subcontracts set status='received',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${contractId} and status in('ready','sent') returning id`)).rows.length!==1) refuse('The subcontract changed during completion.','subcontract_write_failed','Reload and retry; the delivery was not posted.');
    await auditChange(tx,{orgId,actorId,table:'mfg_subcontracts',rowId:contractId,action:'update',before:record,after:{...record,status:'received',quantityReturned:total,finishReason:reason}});
  }
  return {id:input.id,quantityReturned:total,status:input.finish?'received':record.status,replayed:false};
}


/** Unused vendor stock returns to its actual source at the exact remaining carried value. */
export async function returnSubcontractComponents(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,input:{id:string;shipmentId:string;date:string;reason:string}) {
  identifiers([input.id,input.shipmentId]);isoDate(input.date,'date');
  const reason=input.reason?.trim();if(!reason||reason.length<5||reason.length>500) refuse('Explain the unused component return.','subcontract_return_reason_required','Enter a reason between five and five hundred characters.');
  const {record,order,scope}=await lockSubcontract(tx,orgId,actorId,contractId);
  const snapshot={...input,reason,subcontractId:contractId};
  const prior=(await tx.execute<{requestSnapshot:unknown;fromMovementId:string;toMovementId:string;value:string;quantity:string}>(sql`select request_snapshot as "requestSnapshot",from_movement_id as "fromMovementId",to_movement_id as "toMovementId",value::text,quantity::text from mfg_subcontract_material_returns where org_id=${orgId} and id=${input.id} for share`)).rows[0];
  if(prior) {if(canonicalJson(prior.requestSnapshot)!==canonicalJson(snapshot)) throw new ManufacturingIdempotencyConflictError();return {id:input.id,...prior,replayed:true};}
  if(!['ready','sent','received'].includes(record.status)||!['released','in_progress','on_hold'].includes(order.status)) refuse('This subcontract is closed to stock returns.','subcontract_not_open','Return unused vendor stock before closing the work order.');
  const shipment=(await tx.execute<{sourceLocationId:string;receiptId:string;itemId:string;lotId:string|null;serialId:string|null}>(sql`select shipment.source_location_id as "sourceLocationId",shipment.to_movement_id as "receiptId",material.component_item_id as "itemId",inbound.lot_id as "lotId",inbound.serial_id as "serialId"
    from mfg_subcontract_shipments shipment join mfg_wo_materials material on material.org_id=shipment.org_id and material.id=shipment.material_id
    join inventory_movements inbound on inbound.org_id=shipment.org_id and inbound.id=shipment.to_movement_id
    where shipment.org_id=${orgId} and shipment.id=${input.shipmentId} and shipment.subcontract_id=${contractId} and inbound.status='posted'
      and not exists(select 1 from inventory_movements where org_id=shipment.org_id and reverses_movement_id in(shipment.from_movement_id,shipment.to_movement_id) and status='posted') for share of shipment,material,inbound`)).rows[0];
  if(!shipment) throw new ManufacturingNotFoundError();
  await assertInspectionIdentifierScope(tx,orgId,actorId,shipment.itemId,scope,shipment);
  const {quantity,value}=await getOnHandWith(tx,orgId,shipment.itemId,record.custodyLocationId,{subsidiaryId:order.subsidiaryId,lotId:shipment.lotId,serialId:shipment.serialId,sourceReceiptMovementId:shipment.receiptId});
  if(cmp(quantity,'0')<=0) refuse('This shipment has no unused stock at the vendor.','subcontract_no_unused_components','Review the shipment’s consumption and previous return.');
  const moved=await transferInventoryTx(tx,orgId,actorId,{itemId:shipment.itemId,fromStockLocationId:record.custodyLocationId,toStockLocationId:shipment.sourceLocationId,quantity,lotId:shipment.lotId,serialId:shipment.serialId,subsidiaryId:order.subsidiaryId,date:input.date,memo:reason,sourceReceiptMovementId:shipment.receiptId,expectedSourceValue:value});
  if((await tx.execute(sql`insert into mfg_subcontract_material_returns(id,org_id,subcontract_id,shipment_id,quantity,value,from_movement_id,to_movement_id,request_snapshot,created_by,updated_by)
    values(${input.id},${orgId},${contractId},${input.shipmentId},${quantity},${moved.value},${moved.fromMovementId},${moved.toMovementId},${JSON.stringify(snapshot)}::jsonb,${actorId},${actorId}) returning id`)).rows.length!==1) refuse('The unused component return was not recorded.','subcontract_write_failed','Reload and retry; nothing was moved.');
  await auditChange(tx,{orgId,actorId,table:'mfg_subcontract_material_returns',rowId:input.id,action:'insert',before:null,after:{...snapshot,...moved,quantity},requestId:input.id});
  return {id:input.id,...moved,quantity,replayed:false};
}

export async function cancelProductionSubcontract(tx:SqlExecutor,orgId:string,actorId:string,contractId:string,reason:string) {
  const {record}=await lockSubcontract(tx,orgId,actorId,contractId);
  const note=reason?.trim();if(!note||note.length<5||note.length>500) refuse('Explain why this vendor assignment is cancelled.','subcontract_cancel_reason_required','Enter a reason between five and five hundred characters.');
  if(record.status==='cancelled') {
    const old=(await tx.execute<{reason:string}>(sql`select cancel_reason as reason from mfg_subcontracts where org_id=${orgId} and id=${contractId}`)).rows[0];
    if(old?.reason!==note) throw new ManufacturingIdempotencyConflictError();return {id:contractId,status:'cancelled',replayed:true};
  }
  if(record.status!=='ready'||(await tx.execute(sql`select id from mfg_subcontract_shipments where org_id=${orgId} and subcontract_id=${contractId}
    union all select id from mfg_subcontract_returns where org_id=${orgId} and subcontract_id=${contractId}
    union all select id from mfg_subcontract_service_bills where org_id=${orgId} and subcontract_id=${contractId} and reversal_entry_id is null limit 1`)).rows.length)
    refuse('This vendor assignment already has physical or cost activity.','subcontract_cancel_has_activity','Preserve the assignment and its history; return unused stock and reverse service cost through their native actions, or hold the work order.');
  if((await tx.execute(sql`update mfg_subcontracts set status='cancelled',cancel_reason=${note},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${contractId} and status='ready' returning id`)).rows.length!==1) refuse('The vendor assignment changed.','subcontract_write_failed','Reload and retry.');
  await auditChange(tx,{orgId,actorId,table:'mfg_subcontracts',rowId:contractId,action:'update',before:record,after:{...record,status:'cancelled',cancelReason:note}});
  return {id:contractId,status:'cancelled',replayed:false};
}
