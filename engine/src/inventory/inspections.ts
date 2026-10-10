import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { businessTodayInTx, isIsoCalendarDate } from "../platform/business-date.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { cmp } from "../money/money.ts";
import { InventoryError, InventoryNotFoundError } from "./contracts.ts";
import { inspectionDecimal, inspectionMeasures, inspectionOutcome, type InspectionPlanSnapshot } from "./inspection-model.ts";
import { lockInventoryPosition } from "./position.ts";
import { emitAvailabilityChanged } from "../webhooks/emit.ts";
import { inspectionSourceActive,inspectionReworkAccepted } from "./inspection-holds.ts";
import { orderResourcesVisible } from "../organization/production-resource-scope.ts";

async function feature(tx:SqlExecutor,orgId:string) {
  if (!await lockAndCheckOrgFeature(tx,orgId,"manufacturing")) throw new ScopeNotFoundError();
}
async function authority(tx:SqlExecutor,orgId:string,actorId:string,subsidiaryId:string|null,permissions:readonly string[]) {
  if (!(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length) throw new InventoryNotFoundError("Inspection not found.");
  let scope:ReadonlySet<string>|null=null;
  for (const permission of permissions) {
    const allowed=await lockActorCommandAuthority(tx,orgId,actorId,subsidiaryId,permission);
    if (allowed!==null) scope=scope===null ? allowed : new Set([...scope].filter(id=>allowed.has(id)));
  }
  return scope;
}
async function audit(tx:SqlExecutor,orgId:string,actorId:string|null,table:string,id:string,before:unknown,after:unknown) {
  const saved=await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},${table},${id},${before==null ? "insert" : "update"},${JSON.stringify({before,after})}::jsonb,${actorId}) returning id`);
  if (saved.rows.length!==1) throw new InventoryError("The inspection evidence was not audited.");
}

/** Plans are tenant-wide configuration; entity-limited actors cannot change shared policy. */
export async function saveInspectionPlan(tx:SqlExecutor,orgId:string,actorId:string,input:{id:string;name:string;itemId:string;point:"receipt"|"operation";operationSequence?:number|null;effectiveFrom:string;effectiveTo?:string|null;measures:unknown;reason:string;expectedRevision?:number}) {
  await feature(tx,orgId);
  if (await authority(tx,orgId,actorId,null,["admin.setup.manage","manufacturing.manage"])!==null) throw new ScopeNotFoundError();
  if (!isUuid(input.id) || !isUuid(input.itemId) || !input.name?.trim() || input.name.length>200 || !input.reason?.trim() || input.reason.trim().length<5 || input.reason.length>500) throw new InventoryError("Choose an item, name the plan, and enter a reason of 5–500 characters.");
  if (!isIsoCalendarDate(input.effectiveFrom) || (input.effectiveTo!=null && (!isIsoCalendarDate(input.effectiveTo) || input.effectiveTo<=input.effectiveFrom))) throw new InventoryError("Use a valid, increasing effective date window.");
  if (!['receipt','operation'].includes(input.point) || (input.point==='operation' && (!Number.isInteger(input.operationSequence) || input.operationSequence!<1)) || (input.point==='receipt' && input.operationSequence!=null)) throw new InventoryError("An operation plan requires a positive operation sequence; receipt plans do not use one.");
  const measures=inspectionMeasures(input.measures);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('inventory.inspection.plan'),hashtext(${orgId+input.itemId+input.point+String(input.operationSequence??"")}))`);
  const item=(await tx.execute<{tracking:string}>(sql`select profile.tracking from items item join item_inventory_profiles profile on profile.org_id=item.org_id and profile.item_id=item.id where item.org_id=${orgId} and item.id=${input.itemId} and item.is_active for share of item,profile`)).rows[0];
  if (!item) throw new InventoryNotFoundError("Inventory item not found.");
  if (input.point==='receipt' && item.tracking==='none') throw new InventoryError("Enable lot or serial tracking before adding a receipt inspection plan; a failed receipt must identify the stock to hold.");
  const before=(await tx.execute<{revision:number;reason:string;name:string;item_id:string;point:string;operation_sequence:number|null;effective_from:string;effective_to:string|null;measures:unknown}>(sql`select revision,reason,name,item_id,point,operation_sequence,effective_from::text,effective_to::text,measures from inventory_inspection_plans where org_id=${orgId} and id=${input.id} for update`)).rows[0];
  const same=before && before.name===input.name.trim() && before.item_id===input.itemId && before.point===input.point && before.operation_sequence===(input.operationSequence??null) && before.effective_from===input.effectiveFrom && before.effective_to===(input.effectiveTo??null) && before.reason===input.reason.trim() && canonicalJson(inspectionMeasures(before.measures))===canonicalJson(measures);
  if (same && (input.expectedRevision===undefined || before.revision===input.expectedRevision || before.revision===input.expectedRevision+1)) return {id:input.id,revision:before.revision};
  if (before ? !Number.isInteger(input.expectedRevision) || input.expectedRevision!==before.revision : input.expectedRevision!==undefined) throw new InventoryError("This inspection plan changed. Reload its current revision before saving.");
  if (before && (await tx.execute(sql`select id from inventory_inspections where org_id=${orgId} and plan_id=${input.id}
    union all select id from mfg_wo_operations where org_id=${orgId} and inspection_plan_snapshot->>'id'=${input.id} limit 1`)).rows.length) {
    if (before.name!==input.name.trim() || before.item_id!==input.itemId || before.point!==input.point || before.operation_sequence!==(input.operationSequence??null) || before.effective_from!==input.effectiveFrom || JSON.stringify(inspectionMeasures(before.measures))!==JSON.stringify(measures)
      || input.effectiveTo==null || input.effectiveTo<await businessTodayInTx(tx,orgId) || (before.effective_to!==null && input.effectiveTo>before.effective_to)) throw new InventoryError("A used inspection plan retains its content. End its window today or later and create the next effective-dated revision.");
  }
  if ((await tx.execute(sql`select id from inventory_inspection_plans where org_id=${orgId} and item_id=${input.itemId} and point=${input.point}
    and operation_sequence is not distinct from ${input.operationSequence??null}::integer and id<>${input.id}
    and daterange(effective_from,effective_to,'[)') && daterange(${input.effectiveFrom}::date,${input.effectiveTo??null}::date,'[)') limit 1`)).rows.length) throw new InventoryError("An inspection plan already covers part of this effective window. End that window before adding a revision.");
  const result=before ? await tx.execute<{id:string}>(sql`update inventory_inspection_plans set revision=revision+1,reason=${input.reason.trim()},name=${input.name.trim()},item_id=${input.itemId},point=${input.point},operation_sequence=${input.operationSequence??null},effective_from=${input.effectiveFrom},effective_to=${input.effectiveTo??null},measures=${JSON.stringify(measures)}::jsonb,updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${input.id} returning id`)
    : await tx.execute<{id:string}>(sql`insert into inventory_inspection_plans(id,org_id,reason,name,item_id,point,operation_sequence,effective_from,effective_to,measures,created_by,updated_by) values(${input.id},${orgId},${input.reason.trim()},${input.name.trim()},${input.itemId},${input.point},${input.operationSequence??null},${input.effectiveFrom},${input.effectiveTo??null},${JSON.stringify(measures)}::jsonb,${actorId},${actorId}) returning id`);
  if (result.rows.length!==1) throw new InventoryError("The inspection plan was not saved.");
  await audit(tx,orgId,actorId,'inventory_inspection_plans',input.id,before,{...input,measures});
  return {id:input.id,revision:before?before.revision+1:1};
}

export async function resolveInspectionPlan(tx:SqlExecutor,orgId:string,itemId:string,point:"receipt"|"operation",date:string,sequence:number|null=null):Promise<InspectionPlanSnapshot|null> {
  const rows=(await tx.execute<{id:string;name:string;point:"receipt"|"operation";operationSequence:number|null;measures:unknown}>(sql`select id,name,point,operation_sequence as "operationSequence",measures from inventory_inspection_plans where org_id=${orgId} and item_id=${itemId} and point=${point} and operation_sequence is not distinct from ${sequence}::integer
    and effective_from<=${date}::date and (effective_to is null or effective_to>${date}::date) order by id for share`)).rows;
  if (rows.length>1) throw new InventoryError("Inspection plans overlap. Correct their effective windows before posting.");
  const row=rows[0];
  return row ? {...row,measures:inspectionMeasures(row.measures)} : null;
}

/** Called by native receipt writers in the posting transaction. Pending quality prevents allocation immediately. */
export async function createReceiptInspection(tx:SqlExecutor,orgId:string,actorId:string|null,movementId:string) {
  if (!await lockAndCheckOrgFeature(tx,orgId,"manufacturing")) return;
  const movement=(await tx.execute<{itemId:string;subsidiaryId:string;locationId:string;quantity:string;lotId:string|null;serialId:string|null;date:string;workOrderId:string|null}>(sql`select movement.item_id as "itemId",movement.subsidiary_id as "subsidiaryId",movement.stock_location_id as "locationId",movement.quantity::text,movement.lot_id as "lotId",movement.serial_id as "serialId",movement.moved_at::date::text as date,work.id as "workOrderId" from inventory_movements movement left join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id left join mfg_work_orders work on work.org_id=entry.org_id and entry.origin='manufacturing' and work.number=entry.custom->>'work_order_number' where movement.org_id=${orgId} and movement.id=${movementId} and movement.status='posted' and movement.quantity>0 and movement.reverses_movement_id is null`)).rows[0];
  if (!movement) throw new InventoryError("Receipt inspection requires a posted inbound movement.");
  const plan=await resolveInspectionPlan(tx,orgId,movement.itemId,'receipt',movement.date);
  if (!plan) return;
  if (!movement.lotId && !movement.serialId) throw new InventoryError("This receipt requires lot or serial evidence for its inspection plan.");
  const saved=await tx.execute<{id:string}>(sql`insert into inventory_inspections(org_id,plan_id,plan_snapshot,item_id,subsidiary_id,stock_location_id,receipt_movement_id,work_order_id,lot_id,serial_id,quantity,created_by,updated_by)
    values(${orgId},${plan.id},${JSON.stringify(plan)}::jsonb,${movement.itemId},${movement.subsidiaryId},${movement.locationId},${movementId},${movement.workOrderId},${movement.lotId},${movement.serialId},${movement.quantity},${actorId},${actorId}) returning id`);
  if (saved.rows.length!==1) throw new InventoryError("The receipt inspection was not created.");
  await audit(tx,orgId,actorId,'inventory_inspections',saved.rows[0]!.id,null,{...movement,planSnapshot:plan,status:'pending'});
}

export interface InspectionRead { id:string; planSnapshot:InspectionPlanSnapshot; itemId:string; subsidiaryId:string; stockLocationId:string|null; receiptMovementId:string|null; workOrderId:string|null; operationId:string|null; lotId:string|null; serialId:string|null; quantity:string; status:"pending"|"pass"|"fail"; disposition:"use_as_is"|"scrap"|"rework"|null; measurements:Record<string,string>; reason:string|null; dispositionResult:Record<string,unknown>|null; reworkWorkOrderId:string|null;reworkCompletedAt:Date|string|null;reworkResolved:boolean;reworkLoss:boolean; sourceActive:boolean }
export async function loadInspection(tx:SqlExecutor,orgId:string,id:string,lock=false):Promise<InspectionRead> {
  if (!isUuid(id)) throw new InventoryNotFoundError("Inspection not found.");
  const row=(await tx.execute<InspectionRead>(sql`select id,plan_snapshot as "planSnapshot",item_id as "itemId",subsidiary_id as "subsidiaryId",stock_location_id as "stockLocationId",receipt_movement_id as "receiptMovementId",work_order_id as "workOrderId",operation_id as "operationId",lot_id as "lotId",serial_id as "serialId",quantity::text,status,disposition,measurements,reason,disposition_result as "dispositionResult",rework_work_order_id as "reworkWorkOrderId",rework_completed_at as "reworkCompletedAt",${inspectionReworkAccepted(sql`inspection`)} as "reworkResolved",exists(select 1 from mfg_work_orders repair where repair.org_id=inspection.org_id and repair.id=inspection.rework_work_order_id and repair.loss_change_id is not null) as "reworkLoss",${inspectionSourceActive(sql`inspection`)} as "sourceActive" from inventory_inspections inspection where org_id=${orgId} and id=${id} ${lock?sql`for update`:sql``}`)).rows[0];
  if (!row) throw new InventoryNotFoundError("Inspection not found.");
  return row;
}
export async function inspectInventory(tx:SqlExecutor,orgId:string,actorId:string,id:string,input:{outcome:"pass"|"fail";measurements:Record<string,string>;reason:string}) {
  await feature(tx,orgId);
  const preview=await loadInspection(tx,orgId,id);
  const scope=await authority(tx,orgId,actorId,preview.subsidiaryId,["items.manage","manufacturing.manage"]);
  if (preview.workOrderId && !(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${preview.workOrderId} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')} for update of work`)).rows.length) throw new InventoryNotFoundError("Inspection not found.");
  if(preview.reworkWorkOrderId&&!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${preview.reworkWorkOrderId} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')} for update of work`)).rows.length)throw new InventoryNotFoundError('Inspection not found.');
  if (preview.stockLocationId && !(await tx.execute(sql`select stock.id from stock_locations stock join locations location on location.org_id=stock.org_id and location.id=stock.location_id where stock.org_id=${orgId} and stock.id=${preview.stockLocationId} ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})} for share of stock,location`)).rows.length) throw new InventoryNotFoundError("Inspection not found.");
  if (preview.stockLocationId) await lockInventoryPosition(tx,preview.itemId,preview.stockLocationId);
  await assertInspectionIdentifierScope(tx,orgId,actorId,preview.itemId,scope,preview);
  const before=await loadInspection(tx,orgId,id,true);
  if (!before.sourceActive) throw new InventoryError("This receipt was reversed. Its inspection remains as historical evidence; inspect the replacement receipt.");
  const status=inspectionOutcome(before.planSnapshot,input.outcome,input.measurements);
  const reason=input.reason?.trim();
  if (!reason || reason.length<5 || reason.length>500) throw new InventoryError("Enter an inspection note of 5–500 characters.");
  if (before.status!=='pending') {
    if (before.status===status && canonicalJson(before.measurements)===canonicalJson(input.measurements) && before.reason===reason) return before;
    throw new InventoryError("This inspection already has an immutable result. Record a new inspection to correct it.");
  }
  const changed=await tx.execute(sql`update inventory_inspections set status=${status},measurements=${JSON.stringify(input.measurements)}::jsonb,reason=${reason},inspected_at=now(),inspected_by=${actorId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='pending' returning id`);
  if (changed.rows.length!==1) throw new InventoryError("The inspection changed; reload it before retrying.");
  await audit(tx,orgId,actorId,'inventory_inspections',id,before,{...input,status});
  if (before.stockLocationId) await emitAvailabilityChanged(tx,orgId,before.itemId,before.stockLocationId);
  return loadInspection(tx,orgId,id);
}

/** This proof is checked inside the native issue transaction; it never admits an arbitrary held-stock issue. */
export async function assertInspectionScrapIssue(tx:SqlExecutor,orgId:string,actorId:string|null,input:{inspectionId:string;itemId:string;subsidiaryId:string;stockLocationId:string;quantity:string;sourceReceiptMovementId?:string;lotId?:string|null;serialId?:string|null}) {
  await feature(tx,orgId);
  if (!actorId) throw new ScopeNotFoundError();
  await authority(tx,orgId,actorId,input.subsidiaryId,["manufacturing.manage","items.manage","items.post"]);
  const inspection=await loadInspection(tx,orgId,input.inspectionId,true);
  if ((await tx.execute(sql`select id from inventory_inspections where org_id=${orgId} and id=${input.inspectionId} and scrap_movement_id is not null`)).rows.length) throw new InventoryError("This failed inspection already has a scrap movement.");
  if (inspection.status!=='fail' || inspection.disposition!==null || inspection.receiptMovementId===null || input.sourceReceiptMovementId!==inspection.receiptMovementId || inspection.itemId!==input.itemId || inspection.subsidiaryId!==input.subsidiaryId || inspection.stockLocationId!==input.stockLocationId || inspection.lotId!==(input.lotId??null) || inspection.serialId!==(input.serialId??null) || cmp(inspection.quantity,inspectionDecimal(input.quantity,"Scrap quantity"))!==0) throw new InventoryError("Scrap must dispose exactly the failed receipt inspection's stock, quantity and legal entity.");
  if (!(await tx.execute(sql`select source.id from inventory_movements source join journal_entries entry on entry.org_id=source.org_id and entry.id=source.journal_entry_id where source.org_id=${orgId} and source.id=${inspection.receiptMovementId} and source.status='posted' and entry.status='posted'
    and not exists(select 1 from inventory_movements reversal where reversal.org_id=source.org_id and reversal.reverses_movement_id=source.id and reversal.status='posted')`)).rows.length) throw new InventoryError("The inspected receipt was reversed; reconcile its inspection before disposing stock.");
}

export { authority as lockInspectionAuthority, audit as auditInspectionChange };

/** Shared identifier holds affect every owning entity, so dispositions require visibility of the complete ownership. */
export async function assertInspectionIdentifierScope(tx:SqlExecutor,orgId:string,actorId:string,itemId:string,scope:ReadonlySet<string>|null,identifiers:{lotId?:string|null;serialId?:string|null}) {
  for (const [kind,identifier] of [['lot',identifiers.lotId],['serial',identifiers.serialId]] as const) if (identifier) {
    const row=(await tx.execute<{createdBy:string|null}>(sql`select created_by as "createdBy" from ${kind==='lot'?sql`lots`:sql`serials`} where org_id=${orgId} and id=${identifier} and item_id=${itemId} for update`)).rows[0];
    if (!row) throw new InventoryNotFoundError("Stock identifier not found.");
    if (scope===null) continue;
    const owners=(await tx.execute<{subsidiaryId:string|null}>(sql`select distinct subsidiary_id as "subsidiaryId" from inventory_movements where org_id=${orgId} and ${kind==='lot'?sql`lot_id`:sql`serial_id`}=${identifier}
      union select distinct subsidiary_id from consignment_stock where org_id=${orgId} and ${kind==='lot'?sql`lot_id`:sql`serial_id`}=${identifier}`)).rows;
    if (owners.some(owner=>owner.subsidiaryId===null||!scope.has(owner.subsidiaryId)) || (!owners.length&&row.createdBy!==actorId)) throw new InventoryNotFoundError("Stock identifier not found.");
  }
}
export async function emitInspectionAvailability(tx:SqlExecutor,orgId:string,inspection:InspectionRead) {
  if (inspection.stockLocationId) await emitAvailabilityChanged(tx,orgId,inspection.itemId,inspection.stockLocationId);
}
