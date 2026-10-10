import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../platform/db.ts';
import {businessToday} from '../platform/business-date.ts';
import {isUuid} from '../platform/uuid.ts';
import {lockActorCommandAuthority} from '../organization/actor-command-authority.ts';
import {actorHasPermission} from '../organization/actor-permissions.ts';
import {subsidiaryScopeAllows,subsidiaryVisibleFilter} from '../organization/subsidiary-scope.ts';
import {saleableLocation} from '../inventory/stock-eligibility.ts';
import {documentResourcesVisible,subcontractServiceResourcesVisible} from '../organization/production-resource-scope.ts';
import {orderResourcesVisible} from './resource-scope.ts';
import {lockManufacturingReadAuthority} from './authority.ts';
import {assertManufacturingFeature} from './gate.ts';
import {ManufacturingNotFoundError} from './errors.ts';

/** Selected-parent projections share the execution fence; hidden children never contribute aggregates. */
export async function readSubcontractWorkspace(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,selectedId?:string,billSearch?:{q:string;selected?:string}) {
  if(billSearch&&(typeof billSearch.q!=='string'||billSearch.q.length>200||billSearch.selected&&!isUuid(billSearch.selected)))throw new ManufacturingNotFoundError();
  if(!isUuid(workOrderId)||(selectedId!==undefined&&!isUuid(selectedId))) throw new ManufacturingNotFoundError();
  await assertManufacturingFeature(tx,orgId,'manufacturingSubcontract');
  const scope=await lockManufacturingReadAuthority(tx,orgId,actorId,null,['manufacturing.read','items.read']);
  const order=(await tx.execute<{subsidiaryId:string;issueLocationId:string|null;status:string}>(sql`select work.subsidiary_id as "subsidiaryId",work.issue_location_id as "issueLocationId",work.status from mfg_work_orders work
    where work.org_id=${orgId} and work.id=${workOrderId} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}`)).rows[0];
  if(!order) throw new ManufacturingNotFoundError();
  const contracts=(await tx.execute<{id:string;operationId:string;operationName:string;laborSource:string;vendorId:string;vendorName:string;custodyName:string;status:string;expected:string;returned:string;serviceRecorded:boolean}>(sql`select contract.id,contract.operation_id as "operationId",operation.name as "operationName",operation.labor_time_source as "laborSource",vendor.id as "vendorId",vendor.display_name as "vendorName",stock.code as "custodyName",contract.status,contract.quantity_expected::text as expected,
    (select coalesce(sum(quantity),0)::text from mfg_subcontract_returns where org_id=contract.org_id and subcontract_id=contract.id) as returned,
    exists(select 1 from mfg_subcontract_service_bills claim join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id and bill.status='posted' and bill.posted_entry_id=claim.source_entry_id
      join journal_entries source on source.org_id=claim.org_id and source.id=claim.source_entry_id and source.status='posted'
      left join journal_entries cost on cost.org_id=claim.org_id and cost.id=claim.capitalization_entry_id
      where claim.org_id=contract.org_id and claim.subcontract_id=contract.id and claim.reversal_entry_id is null and (claim.amount=0 or cost.status='posted')) as "serviceRecorded"
    from mfg_subcontracts contract join mfg_wo_operations operation on operation.org_id=contract.org_id and operation.id=contract.operation_id
    join parties vendor on vendor.org_id=contract.org_id and vendor.id=contract.vendor_id join stock_locations stock on stock.org_id=contract.org_id and stock.id=contract.custody_location_id
    where contract.org_id=${orgId} and contract.work_order_id=${workOrderId} order by operation.sequence,contract.created_at desc`)).rows;
  const selected=selectedId?contracts.find(record=>record.id===selectedId):contracts.find(record=>record.status!=='cancelled')??contracts[0];
  if(selectedId&&!selected) throw new ManufacturingNotFoundError();
  const operations=(await tx.execute<{value:string;label:string}>(sql`select operation.id as value,concat(operation.sequence,' · ',operation.name) as label from mfg_wo_operations operation
    where operation.org_id=${orgId} and operation.work_order_id=${workOrderId} and operation.status in('pending','running') and operation.backflush_at='none'
      and not exists(select 1 from mfg_subcontracts where org_id=operation.org_id and operation_id=operation.id and status<>'cancelled') order by operation.sequence`)).rows;
  const custody=(await tx.execute<{value:string;label:string;vendorId:string;vendorName:string}>(sql`select stock.id as value,stock.code as label,vendor.id as "vendorId",vendor.display_name as "vendorName"
    from stock_locations stock join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    join parties vendor on vendor.org_id=stock.org_id and vendor.id=stock.custodian_party_id
    where stock.org_id=${orgId} and stock.kind='subcontract' and stock.is_active and vendor.is_active
      and (vendor.kind='vendor' or exists(select 1 from vendor_roles where org_id=vendor.org_id and party_id=vendor.id))
      ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})} ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`,scope,{orgWideNull:true})} order by vendor.display_name,stock.code`)).rows;
  const materials=(await tx.execute<{value:string;label:string;itemId:string;required:string;issued:string}>(sql`select material.id as value,coalesce(item.code,item.name) as label,item.id as "itemId",material.required_qty::text as required,(material.issued_qty+material.backflush_qty)::text as issued
    from mfg_wo_materials material join items item on item.org_id=material.org_id and item.id=material.component_item_id
    where material.org_id=${orgId} and material.work_order_id=${workOrderId}
    ${selected?sql`and (material.operation_seq is null or material.operation_seq=(select sequence from mfg_wo_operations where org_id=${orgId} and id=${selected.operationId}))`:sql``}
    order by item.name,material.id`)).rows;
  const shipments=selected?(await tx.execute<{id:string;materialId:string;itemId:string;label:string;quantity:string;remaining:string;lotId:string|null;serialId:string|null;lotNumber:string|null;serialNumber:string|null;date:string}>(sql`select shipment.id,shipment.material_id as "materialId",material.component_item_id as "itemId",coalesce(item.code,item.name) as label,shipment.quantity::text,
    (select coalesce(sum(remaining_quantity),0)::text from cost_layers where org_id=shipment.org_id and source_movement_id=shipment.to_movement_id) as remaining,
    movement.lot_id as "lotId",movement.serial_id as "serialId",lot.lot_number as "lotNumber",serial.serial_number as "serialNumber",shipment.created_at::text as date
    from mfg_subcontract_shipments shipment join mfg_wo_materials material on material.org_id=shipment.org_id and material.id=shipment.material_id
    join items item on item.org_id=material.org_id and item.id=material.component_item_id join inventory_movements movement on movement.org_id=shipment.org_id and movement.id=shipment.to_movement_id
    left join lots lot on lot.org_id=movement.org_id and lot.id=movement.lot_id left join serials serial on serial.org_id=movement.org_id and serial.id=movement.serial_id
    where shipment.org_id=${orgId} and shipment.subcontract_id=${selected.id} order by shipment.created_at,shipment.id`)).rows:[];
  const sourceLocations=(await tx.execute<{value:string;label:string}>(sql`select stock.id as value,stock.code as label from stock_locations stock join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where stock.org_id=${orgId} and stock.is_active ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})} and ${saleableLocation(sql`${orgId}`,sql`stock.id`)} order by stock.code`)).rows;
  async function payablesScope(permission:string) {
    if(!await actorHasPermission(tx,orgId,actorId,permission))return {canUse:false,scope};
    const granted=await lockActorCommandAuthority(tx,orgId,actorId,null,permission);
    const effective=granted===null?scope:scope===null?granted:new Set([...scope].filter(id=>granted.has(id)));
    const visible=(await tx.execute<{visible:boolean}>(sql`select ${subcontractServiceResourcesVisible(effective,sql`${orgId}`,sql`${workOrderId}::uuid`)} as visible`)).rows[0]?.visible;
    return {canUse:subsidiaryScopeAllows(effective,order.subsidiaryId)&&visible===true,scope:effective};
  }
  const reading=await payablesScope('ap.read'),posting=await payablesScope('ap.post');
  const canReadBills=reading.canUse,canRecordService=posting.canUse;
  const hasOutput=(await tx.execute(sql`select id from inventory_movements where org_id=${orgId} and kind='assembly_build' and journal_entry_id in (select id from journal_entries where org_id=${orgId} and origin='manufacturing' and custom->>'work_order_number'=(select number from mfg_work_orders where org_id=${orgId} and id=${workOrderId}) and status='posted' and reverses_entry_id is null) limit 1`)).rows.length>0;
  const services=selected&&canReadBills?(await tx.execute<{id:string;billId:string;number:string;amount:string;entryId:string|null;reversalId:string|null;reason:string|null;date:string}>(sql`select claim.id,claim.bill_id as "billId",bill.document_number as number,claim.amount::text,claim.capitalization_entry_id as "entryId",claim.reversal_entry_id as "reversalId",claim.reversal_reason as reason,claim.created_at::text as date from mfg_subcontract_service_bills claim join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id where claim.org_id=${orgId} and claim.subcontract_id=${selected.id} order by claim.created_at,claim.id`)).rows:[];
  const deliveries=selected?(await tx.execute<{id:string;quantity:string;final:boolean;reason:string|null;date:string}>(sql`select id,quantity::text,coalesce((request_snapshot->>'finish')::boolean,false) as final,finish_reason as reason,created_at::text as date from mfg_subcontract_returns where org_id=${orgId} and subcontract_id=${selected.id} order by created_at,id`)).rows:[];
  const cancellable=!!selected&&selected.status==='ready'&&!shipments.length&&!deliveries.length&&!(await tx.execute(sql`select id from mfg_subcontract_service_bills where org_id=${orgId} and subcontract_id=${selected.id} and reversal_entry_id is null limit 1`)).rows.length;
  const bills=selected&&canReadBills?(await tx.execute<{value:string;label:string}>(sql`select bill.id as value,bill.document_number as label from documents bill
    join mfg_subcontracts contract on contract.org_id=bill.org_id and contract.id=${selected.id} and contract.vendor_id=bill.party_id
    where bill.org_id=${orgId} and bill.kind='vendor_bill' and bill.status='posted' and bill.subsidiary_id=${order.subsidiaryId}
      and not exists(select 1 from mfg_subcontract_service_bills where org_id=bill.org_id and bill_id=bill.id and reversal_entry_id is null)
      and ${documentResourcesVisible(reading.scope,'bill')}
      ${billSearch?sql`and (bill.document_number ilike ${'%'+billSearch.q+'%'} or bill.id=${billSearch.selected??null}::uuid)`:sql``}
    order by ${billSearch?.selected?sql`(bill.id=${billSearch.selected}::uuid) desc,`:sql``} bill.document_date desc,bill.id limit 100`)).rows:[];
  return {date:await businessToday(orgId),order,contracts,selected: selected??null,operations,custody,materials,shipments,sourceLocations,bills,services,deliveries,hasOutput,cancellable,canReadBills,canRecordService};
}


/** Older posted bills remain searchable within the same selected order and native authority. */
export async function searchProductionServiceBills(tx:SqlExecutor,orgId:string,actorId:string,workOrderId:string,contractId:string,q='',selected?:string) {
 const workspace=await readSubcontractWorkspace(tx,orgId,actorId,workOrderId,contractId,{q,selected});
 if(!workspace.canReadBills)throw new ManufacturingNotFoundError();
 return workspace.bills;
}
