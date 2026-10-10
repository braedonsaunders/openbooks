import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingReadAuthority } from "./authority.ts";
import { routingResourcesVisible,orderResourcesVisible } from "./resource-scope.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { inspectionSourceActive } from "../inventory/inspection-holds.ts";
import { loadInspection } from "../inventory/inspections.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { businessToday } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";

export interface InspectionQueueRow { id:string;name:string;itemName:string;status:string;disposition:string|null;quantity:string;lotNumber:string|null;serialNumber:string|null;workOrderId:string|null;operationId:string|null;receiptMovementId:string|null;createdAt:Date|string;totalCount:string;sourceActive:boolean }
function visible(scope:ReadonlySet<string>|null) {
  return sql`${subsidiaryVisibleFilter(sql`inspection.subsidiary_id`,scope)}
    and not exists(select 1 from inventory_movements owner where owner.org_id=inspection.org_id
      and ((inspection.lot_id is not null and owner.lot_id=inspection.lot_id) or (inspection.serial_id is not null and owner.serial_id=inspection.serial_id))
      and not(true ${subsidiaryVisibleFilter(sql`owner.subsidiary_id`,scope)}))
    and not exists(select 1 from consignment_stock owner where owner.org_id=inspection.org_id
      and ((inspection.lot_id is not null and owner.lot_id=inspection.lot_id) or (inspection.serial_id is not null and owner.serial_id=inspection.serial_id))
      and not(true ${subsidiaryVisibleFilter(sql`owner.subsidiary_id`,scope)}))
    and (inspection.work_order_id is null or exists(select 1 from mfg_work_orders work where work.org_id=inspection.org_id and work.id=inspection.work_order_id ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}))
    and (inspection.rework_work_order_id is null or exists(select 1 from mfg_work_orders work where work.org_id=inspection.org_id and work.id=inspection.rework_work_order_id ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}))
    and (inspection.stock_location_id is null or exists(select 1 from stock_locations stock join locations location on location.org_id=stock.org_id and location.id=stock.location_id where stock.org_id=inspection.org_id and stock.id=inspection.stock_location_id ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))`;
}
export async function assertManufacturingInspectionScope(tx:SqlExecutor,orgId:string,id:string,scope:ReadonlySet<string>|null) {
  if (!(await tx.execute(sql`select inspection.id from inventory_inspections inspection where inspection.org_id=${orgId} and inspection.id=${id} ${visible(scope)}`)).rows.length) throw new ManufacturingNotFoundError();
}
export async function listManufacturingInspections(tx:SqlExecutor,orgId:string,actorId:string,query:{workOrderId?:string;status?:'pending'|'pass'|'fail';page?:number}) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  const scope=await lockManufacturingReadAuthority(tx,orgId,actorId,null,['manufacturing.read','items.read']);
  const page=query.page??1;
  if (!Number.isInteger(page) || page<1 || page>100000 || (query.workOrderId&&!isUuid(query.workOrderId))) throw new ManufacturingError("Choose a valid inspection page or work order.",{code:'invalid_inspection_query'});
  const predicate=sql`inspection.org_id=${orgId} ${visible(scope)} ${query.workOrderId?sql`and inspection.work_order_id=${query.workOrderId}`:sql``} ${query.status?sql`and inspection.status=${query.status} ${query.status==='pending'?sql`and ${inspectionSourceActive(sql`inspection`)}`:sql``}`:sql``}`;
  const rows=(await tx.execute<InspectionQueueRow>(sql`select inspection.id,inspection.status,inspection.disposition,inspection.quantity::text,inspection.plan_snapshot->>'name' as name,item.name as "itemName",lot.lot_number as "lotNumber",serial.serial_number as "serialNumber",inspection.work_order_id as "workOrderId",inspection.operation_id as "operationId",inspection.receipt_movement_id as "receiptMovementId",inspection.created_at as "createdAt",count(*) over()::text as "totalCount",${inspectionSourceActive(sql`inspection`)} as "sourceActive"
    from inventory_inspections inspection join items item on item.org_id=inspection.org_id and item.id=inspection.item_id left join lots lot on lot.org_id=inspection.org_id and lot.id=inspection.lot_id left join serials serial on serial.org_id=inspection.org_id and serial.id=inspection.serial_id
    where ${predicate} order by inspection.created_at desc,inspection.id desc limit 25 offset ${(page-1)*25}`)).rows;
  const total=rows[0]?Number(rows[0].totalCount):Number((await tx.execute<{count:string}>(sql`select count(*)::text as count from inventory_inspections inspection where ${predicate}`)).rows[0]?.count??0);
  return {rows,total,page,perPage:25};
}
export async function readManufacturingInspection(tx:SqlExecutor,orgId:string,actorId:string,id:string) {
  await assertManufacturingFeature(tx,orgId,'manufacturing');
  if (!isUuid(id)) throw new ManufacturingNotFoundError();
  const scope=await lockManufacturingReadAuthority(tx,orgId,actorId,null,['manufacturing.read','items.read']);
  await assertManufacturingInspectionScope(tx,orgId,id,scope);
  const labels=(await tx.execute<{itemName:string;tracking:'none'|'lot'|'serial'|'lot_serial';lotNumber:string|null;serialNumber:string|null;workOrderNumber:string|null;operationName:string|null;operationStatus:string|null;workStatus:string|null}>(sql`select item.name as "itemName",profile.tracking,lot.lot_number as "lotNumber",serial.serial_number as "serialNumber",work.number as "workOrderNumber",operation.name as "operationName",operation.status as "operationStatus",work.status as "workStatus" from inventory_inspections inspection join items item on item.org_id=inspection.org_id and item.id=inspection.item_id join item_inventory_profiles profile on profile.org_id=item.org_id and profile.item_id=item.id left join lots lot on lot.org_id=inspection.org_id and lot.id=inspection.lot_id left join serials serial on serial.org_id=inspection.org_id and serial.id=inspection.serial_id left join mfg_work_orders work on work.org_id=inspection.org_id and work.id=inspection.work_order_id left join mfg_wo_operations operation on operation.org_id=inspection.org_id and operation.id=inspection.operation_id where inspection.org_id=${orgId} and inspection.id=${id}`)).rows[0]!;
  const inspection=await loadInspection(tx,orgId,id);
  const remaining=inspection.operationId?(await tx.execute<{quantity:string}>(sql`select greatest(quantity_planned-quantity_scrapped_here,0)::text as quantity from mfg_wo_operations where org_id=${orgId} and id=${inspection.operationId} and work_order_id=${inspection.workOrderId}`)).rows[0]?.quantity??null:null;
  const today=await businessToday(orgId);
  const reworkOperations=inspection.receiptMovementId&&inspection.status==='fail'&&!inspection.disposition?(await tx.execute<{value:string;label:string;routingId:string;sequence:number}>(sql`select route.id::text||':'||operation.sequence::text as value,route.code||' · '||operation.sequence||' · '||operation.name as label,route.id as "routingId",operation.sequence from mfg_routings route join mfg_routing_operations operation on operation.org_id=route.org_id and operation.routing_id=route.id where route.org_id=${orgId} and route.produced_item_id=${inspection.itemId} and route.status='active' and route.effective_from<=${today}::date and (route.effective_to is null or ${today}::date<route.effective_to) ${routingResourcesVisible(scope,'route')} order by route.version,operation.sequence`)).rows:[];
  const canFollowup=Boolean(inspection.sourceActive&&inspection.operationId&&['running','paused'].includes(labels.operationStatus??'')&&['released','in_progress'].includes(labels.workStatus??'')&&!(await tx.execute(sql`select id from inventory_inspections where org_id=${orgId} and operation_id=${inspection.operationId} and status='pending' limit 1`)).rows.length);
  return {...inspection,...labels,remainingInspectionQuantity:remaining,canFollowup,reworkOperations};
}
