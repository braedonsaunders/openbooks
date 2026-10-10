import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { ScopeNotFoundError } from "./subsidiary-scope.ts";
import { subsidiaryVisibleFilter } from "./subsidiary-scope.ts";

export function centerResourcesVisible(scope:ReadonlySet<string>|null,alias:'center'|'c'|'r'='center'):SQL {
  const column=(name:string)=>sql.raw(`${alias}.${name}`);
  return sql`${subsidiaryVisibleFilter(column('subsidiary_id'),scope)}
    and (${column('department_id')} is null or exists(select 1 from departments department
      where department.org_id=${column('org_id')} and department.id=${column('department_id')}
      ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})}))
    and (${column('calendar_id')} is null or exists(select 1 from schedule_calendars calendar
      left join projects project on project.org_id=calendar.org_id and project.id=calendar.project_id
      where calendar.org_id=${column('org_id')} and calendar.id=${column('calendar_id')}
        and (calendar.project_id is null or project.id is not null and true ${subsidiaryVisibleFilter(sql`project.subsidiary_id`,scope)})))`;
}

export function orderResourcesVisible(scope: ReadonlySet<string> | null, alias: "r" | "c" | "work" | "source",includeRework=true): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return sql`${includeRework?sql`and (${column("receipt_rework_inspection_id")} is null or exists (
    select 1 from inventory_inspections failed join stock_locations stock on stock.org_id=failed.org_id and stock.id=failed.stock_location_id
      join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where failed.org_id=${column("org_id")} and failed.id=${column("receipt_rework_inspection_id")}
      ${subsidiaryVisibleFilter(sql`failed.subsidiary_id`,scope)} ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}
      and not exists(select 1 from inventory_movements owner where owner.org_id=failed.org_id
        and ((failed.lot_id is not null and owner.lot_id=failed.lot_id) or (failed.serial_id is not null and owner.serial_id=failed.serial_id))
        and not(true ${subsidiaryVisibleFilter(sql`owner.subsidiary_id`,scope)}))
      and not exists(select 1 from consignment_stock owner where owner.org_id=failed.org_id
        and ((failed.lot_id is not null and owner.lot_id=failed.lot_id) or (failed.serial_id is not null and owner.serial_id=failed.serial_id))
        and not(true ${subsidiaryVisibleFilter(sql`owner.subsidiary_id`,scope)}))
      and not exists (
        with recursive origins as (
          select original.* ,array[original.id] as path from mfg_work_orders original where original.org_id=failed.org_id and original.id=failed.work_order_id
          union all select parent.*,origins.path||parent.id from origins join inventory_inspections prior on prior.org_id=origins.org_id and prior.id=origins.receipt_rework_inspection_id
            join mfg_work_orders parent on parent.org_id=prior.org_id and parent.id=prior.work_order_id where not parent.id=any(origins.path)
        ) select 1 from origins source where not(true ${subsidiaryVisibleFilter(sql`source.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'source',false)})
      )
  ))`:sql``} and (${column("routing_id")} is null or exists (
    select 1 from mfg_routings v where v.org_id=${column("org_id")} and v.id=${column("routing_id")}
    ${routingResourcesVisible(scope,'v')}
  )) and not exists (
    select 1 from mfg_wo_operations operation
    left join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
    left join departments department on department.org_id=center.org_id and department.id=center.department_id
    where operation.org_id=${column("org_id")} and operation.work_order_id=${column("id")}
      and (center.id is null or not (true ${centerResourcesVisible(scope)}))
  ) and not exists (
    select 1 from mfg_subcontracts contract
    left join parties vendor on vendor.org_id=contract.org_id and vendor.id=contract.vendor_id
    left join stock_locations stock on stock.org_id=contract.org_id and stock.id=contract.custody_location_id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where contract.org_id=${column("org_id")} and contract.work_order_id=${column("id")}
      and (vendor.id is null or location.id is null
        or not(true ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`,scope,{orgWideNull:true})})
        or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))
  ) and not exists (
    select 1 from mfg_subcontract_service_bills claim
    join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id
    left join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id
    left join journal_entries source on source.org_id=claim.org_id and source.id=claim.source_entry_id
    left join journal_lines line on line.org_id=source.org_id and line.entry_id=source.id
    left join departments department on department.org_id=line.org_id and department.id=line.department_id
    left join locations location on location.org_id=line.org_id and location.id=line.location_id
    where contract.org_id=${column("org_id")} and contract.work_order_id=${column("id")}
      and (bill.id is null or source.id is null or not(${documentResourcesVisible(scope,'bill')})
        or not(true ${subsidiaryVisibleFilter(sql`bill.subsidiary_id`,scope)})
        or not(true ${subsidiaryVisibleFilter(sql`source.subsidiary_id`,scope)})
        or (line.id is not null and not(true ${subsidiaryVisibleFilter(sql`line.subsidiary_id`,scope)}))
        or (line.department_id is not null and (department.id is null or not(true ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})})))
        or (line.location_id is not null and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))))
  ) and not exists (
    select 1 from mfg_subcontract_shipments shipment
    join mfg_subcontracts contract on contract.org_id=shipment.org_id and contract.id=shipment.subcontract_id
    left join stock_locations stock on stock.org_id=shipment.org_id and stock.id=shipment.source_location_id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where contract.org_id=${column("org_id")} and contract.work_order_id=${column("id")}
      and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))
  ) and not exists (
    select 1 from unnest(array[${column("issue_location_id")},${column("receipt_location_id")}]) resource(id)
    left join stock_locations stock on stock.org_id=${column("org_id")} and stock.id=resource.id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where resource.id is not null and (location.id is null or not (true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`, scope, { orgWideNull: true })}))
  ) and not exists (
    select 1 from journal_entries entry
    left join inventory_movements movement on movement.org_id=entry.org_id and movement.journal_entry_id=entry.id
    left join stock_locations stock on stock.org_id=movement.org_id and stock.id=movement.stock_location_id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where entry.org_id=${column("org_id")} and entry.origin='manufacturing'
      and entry.custom->>'work_order_number'=${column("number")}
      and (not (true ${subsidiaryVisibleFilter(sql`entry.subsidiary_id`, scope)})
        or (movement.id is not null and (location.id is null
          or not (true ${subsidiaryVisibleFilter(sql`movement.subsidiary_id`, scope)})
          or not (true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`, scope, { orgWideNull: true })}))))
  )`;
}

export function routingResourcesVisible(scope: ReadonlySet<string> | null, alias: "r" | "v" | "route" = "r"): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return sql` and not exists (
    select 1 from mfg_routing_operations operation
    left join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
    left join departments department on department.org_id=center.org_id and department.id=center.department_id
    where operation.org_id=${column("org_id")} and operation.routing_id=${column("id")}
      and (center.id is null or not (true ${centerResourcesVisible(scope)}))
  ) and not exists (
    select 1 from unnest(array[${column("default_issue_location_id")},${column("default_receipt_location_id")}]) resource(id)
    left join stock_locations stock on stock.org_id=${column("org_id")} and stock.id=resource.id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where resource.id is not null and (location.id is null or not (true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`, scope, { orgWideNull: true })}))
  )`;
}

/** Pin mutable entity-bearing references before a command rechecks its complete scope. */
export async function pinProductionOrderResources(tx:SqlExecutor,orgId:string,workOrderId:string) {
  const orders=(await tx.execute<{id:string}>(sql`with recursive subjects as (
    select id,receipt_rework_inspection_id,array[id] as path from mfg_work_orders where org_id=${orgId} and id=${workOrderId}
    union all select original.id,original.receipt_rework_inspection_id,subjects.path||original.id from subjects
      join inventory_inspections inspection on inspection.org_id=${orgId} and inspection.id=subjects.receipt_rework_inspection_id
      join mfg_work_orders original on original.org_id=inspection.org_id and original.id=inspection.work_order_id where not original.id=any(subjects.path)
    ) select id from subjects order by id`)).rows;
  const ids=sql.join(orders.map(row=>sql`${row.id}::uuid`),sql`, `);
  if(!orders.length)throw new ScopeNotFoundError();
  await tx.execute(sql`select route.id from mfg_routings route where route.org_id=${orgId} and route.id in (
    select routing_id from mfg_work_orders where org_id=${orgId} and id in(${ids})
  ) order by route.id for share`);
  await tx.execute(sql`select center.id from mfg_work_centers center where center.org_id=${orgId} and center.id in (
    select work_center_id from mfg_wo_operations where org_id=${orgId} and work_order_id in(${ids})
    union select operation.work_center_id from mfg_routing_operations operation join mfg_work_orders work on work.org_id=operation.org_id and work.routing_id=operation.routing_id where work.org_id=${orgId} and work.id in(${ids})
  ) order by center.id for share`);
  await tx.execute(sql`select department.id from departments department where department.org_id=${orgId} and department.id in (
    select center.department_id from mfg_work_centers center where center.org_id=${orgId} and center.id in (
      select work_center_id from mfg_wo_operations where org_id=${orgId} and work_order_id in(${ids})
      union select operation.work_center_id from mfg_routing_operations operation join mfg_work_orders work on work.org_id=operation.org_id and work.routing_id=operation.routing_id where work.org_id=${orgId} and work.id in(${ids})
    ) union select line.department_id from journal_lines line join mfg_subcontract_service_bills claim on claim.org_id=line.org_id and claim.source_entry_id=line.entry_id join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id where contract.org_id=${orgId} and contract.work_order_id in(${ids})
  ) order by department.id for share`);
  await tx.execute(sql`select calendar.id from schedule_calendars calendar where calendar.org_id=${orgId} and calendar.id in (
    select center.calendar_id from mfg_work_centers center where center.org_id=${orgId} and center.id in (
      select work_center_id from mfg_wo_operations where org_id=${orgId} and work_order_id in(${ids})
      union select operation.work_center_id from mfg_routing_operations operation join mfg_work_orders work on work.org_id=operation.org_id and work.routing_id=operation.routing_id where work.org_id=${orgId} and work.id in(${ids})
    )
  ) order by calendar.id for share`);
  await tx.execute(sql`select project.id from projects project where project.org_id=${orgId} and project.id in (
    select calendar.project_id from schedule_calendars calendar join mfg_work_centers center on center.org_id=calendar.org_id and center.calendar_id=calendar.id where center.org_id=${orgId} and center.id in (
      select work_center_id from mfg_wo_operations where org_id=${orgId} and work_order_id in(${ids})
      union select operation.work_center_id from mfg_routing_operations operation join mfg_work_orders work on work.org_id=operation.org_id and work.routing_id=operation.routing_id where work.org_id=${orgId} and work.id in(${ids})
    )
  ) order by project.id for share`);
  const stocks=(await tx.execute<{id:string}>(sql`select stock.id from stock_locations stock where stock.org_id=${orgId} and stock.id in (
    select issue_location_id from mfg_work_orders where org_id=${orgId} and id in(${ids})
    union select receipt_location_id from mfg_work_orders where org_id=${orgId} and id in(${ids})
    union select inspection.stock_location_id from inventory_inspections inspection join mfg_work_orders work on work.org_id=inspection.org_id and work.receipt_rework_inspection_id=inspection.id where work.org_id=${orgId} and work.id in(${ids})
    union select contract.custody_location_id from mfg_subcontracts contract where contract.org_id=${orgId} and contract.work_order_id in(${ids})
    union select shipment.source_location_id from mfg_subcontract_shipments shipment join mfg_subcontracts contract on contract.org_id=shipment.org_id and contract.id=shipment.subcontract_id where contract.org_id=${orgId} and contract.work_order_id in(${ids})
    union select movement.stock_location_id from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id join mfg_work_orders work on work.org_id=entry.org_id and work.number=entry.custom->>'work_order_number' where work.org_id=${orgId} and work.id in(${ids}) and entry.origin='manufacturing'
    union select route.default_issue_location_id from mfg_routings route join mfg_work_orders work on work.org_id=route.org_id and work.routing_id=route.id where work.org_id=${orgId} and work.id in(${ids})
    union select route.default_receipt_location_id from mfg_routings route join mfg_work_orders work on work.org_id=route.org_id and work.routing_id=route.id where work.org_id=${orgId} and work.id in(${ids})
  ) order by stock.id for share`)).rows;
  await tx.execute(sql`select location.id from locations location where location.org_id=${orgId} and location.id in (
    select location_id from stock_locations where org_id=${orgId} ${stocks.length?sql`and id in(${sql.join(stocks.map(row=>sql`${row.id}::uuid`),sql`, `)})`:sql`and false`}
    union select line.location_id from journal_lines line join mfg_subcontract_service_bills claim on claim.org_id=line.org_id and claim.source_entry_id=line.entry_id join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id where contract.org_id=${orgId} and contract.work_order_id in(${ids})
  ) order by location.id for share`);
  await tx.execute(sql`select vendor.id from parties vendor where vendor.org_id=${orgId} and vendor.id in (
    select vendor_id from mfg_subcontracts where org_id=${orgId} and work_order_id in(${ids})
    union select line.party_id from journal_lines line join mfg_subcontract_service_bills claim on claim.org_id=line.org_id and claim.source_entry_id=line.entry_id join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id where contract.org_id=${orgId} and contract.work_order_id in(${ids})
  ) order by vendor.id for share`);
  await tx.execute(sql`select project.id from projects project where project.org_id=${orgId} and project.id in (
    select line.project_id from journal_lines line join mfg_subcontract_service_bills claim on claim.org_id=line.org_id and claim.source_entry_id=line.entry_id join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id where contract.org_id=${orgId} and contract.work_order_id in(${ids})
  ) order by project.id for share`);
  const bills = (await tx.execute<{id:string}>(sql`select distinct claim.bill_id as id from mfg_subcontract_service_bills claim
    join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id
    where contract.org_id=${orgId} and contract.work_order_id in(${ids}) order by claim.bill_id`)).rows;
  for (const bill of bills) await pinProductionDocumentResources(tx,orgId,bill.id);
}

/** Pin a service bill's complete resource composition before checking live entity authority. */
export async function pinProductionDocumentResources(tx:SqlExecutor,orgId:string,documentId:string) {
  await tx.execute(sql`select id from documents where org_id=${orgId} and id=${documentId} for share`);
  await tx.execute(sql`select id from document_lines where org_id=${orgId} and document_id=${documentId} order by id for share`);
  const resources=sql`select party_id,department_id,project_id,location_id,null::uuid as stock_location_id from documents where org_id=${orgId} and id=${documentId}
    union all select party_id,department_id,project_id,location_id,stock_location_id from document_lines where org_id=${orgId} and document_id=${documentId}`;
  await tx.execute(sql`select stock.id from stock_locations stock where stock.org_id=${orgId} and stock.id in(select stock_location_id from (${resources}) resource) order by stock.id for share`);
  await tx.execute(sql`select party.id from parties party where party.org_id=${orgId} and party.id in(select party_id from (${resources}) resource) order by party.id for share`);
  await tx.execute(sql`select department.id from departments department where department.org_id=${orgId} and department.id in(select department_id from (${resources}) resource) order by department.id for share`);
  await tx.execute(sql`select project.id from projects project where project.org_id=${orgId} and project.id in(select project_id from (${resources}) resource) order by project.id for share`);
  await tx.execute(sql`select location.id from locations location where location.org_id=${orgId} and location.id in(
    select location_id from (${resources}) resource
    union select stock.location_id from stock_locations stock where stock.org_id=${orgId} and stock.id in(select stock_location_id from (${resources}) resource)
  ) order by location.id for share`);
}


/** Whole-document resource visibility is shared by planning and production service-bill selection. */
export function documentResourcesVisible(scope:ReadonlySet<string>|null,alias:'bill'|'document'):SQL {
 const column=(name:string)=>sql.raw(`${alias}.${name}`);
 return sql`not exists(
  select 1 from (
    select ${column('party_id')} as party_id,${column('department_id')} as department_id,${column('project_id')} as project_id,${column('location_id')} as location_id,null::uuid as stock_location_id,${column('subsidiary_id')} as subsidiary_id
    union all select line.party_id,line.department_id,line.project_id,line.location_id,line.stock_location_id,line.subsidiary_id from document_lines line where line.org_id=${column('org_id')} and line.document_id=${column('id')}
  ) resource left join parties party on party.org_id=${column('org_id')} and party.id=resource.party_id
  left join departments department on department.org_id=${column('org_id')} and department.id=resource.department_id
  left join projects project on project.org_id=${column('org_id')} and project.id=resource.project_id
  left join locations location on location.org_id=${column('org_id')} and location.id=resource.location_id
  left join stock_locations stock on stock.org_id=${column('org_id')} and stock.id=resource.stock_location_id
  left join locations stock_location on stock_location.org_id=stock.org_id and stock_location.id=stock.location_id
  where not(true ${subsidiaryVisibleFilter(sql`resource.subsidiary_id`,scope,{orgWideNull:true})})
    or resource.party_id is not null and (party.id is null or not(true ${subsidiaryVisibleFilter(sql`party.subsidiary_id`,scope,{orgWideNull:true})}))
    or resource.department_id is not null and (department.id is null or not(true ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})}))
    or resource.project_id is not null and (project.id is null or not(true ${subsidiaryVisibleFilter(sql`project.subsidiary_id`,scope)}))
    or resource.location_id is not null and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))
    or resource.stock_location_id is not null and (stock_location.id is null or not(true ${subsidiaryVisibleFilter(sql`stock_location.subsidiary_id`,scope,{orgWideNull:true})}))
 )`;
}

export function subcontractServiceResourcesVisible(scope:ReadonlySet<string>|null,org:SQL,workOrderId:SQL):SQL {
 return sql`not exists(select 1 from mfg_subcontract_service_bills claim join mfg_subcontracts contract on contract.org_id=claim.org_id and contract.id=claim.subcontract_id
  left join documents bill on bill.org_id=claim.org_id and bill.id=claim.bill_id
  left join journal_entries source on source.org_id=claim.org_id and source.id=claim.source_entry_id
  where contract.org_id=${org} and contract.work_order_id=${workOrderId}
    and (bill.id is null or source.id is null or not(${documentResourcesVisible(scope,'bill')})
      or not(true ${subsidiaryVisibleFilter(sql`source.subsidiary_id`,scope)})
      or exists(select 1 from journal_lines line left join departments department on department.org_id=line.org_id and department.id=line.department_id
       left join locations location on location.org_id=line.org_id and location.id=line.location_id left join projects project on project.org_id=line.org_id and project.id=line.project_id
       left join parties party on party.org_id=line.org_id and party.id=line.party_id
       where line.org_id=source.org_id and line.entry_id=source.id and (
        not(true ${subsidiaryVisibleFilter(sql`line.subsidiary_id`,scope)})
        or line.department_id is not null and (department.id is null or not(true ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})}))
        or line.location_id is not null and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}))
        or line.project_id is not null and (project.id is null or not(true ${subsidiaryVisibleFilter(sql`project.subsidiary_id`,scope)}))
        or line.party_id is not null and (party.id is null or not(true ${subsidiaryVisibleFilter(sql`party.subsidiary_id`,scope,{orgWideNull:true})}))
       ))))`;
}
