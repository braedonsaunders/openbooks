import { workProfileFilter,workDepartmentFilter } from "../organization/work-list-filters.ts";
import { readPinnedOperatingProfile } from "../organization/operating-profiles.ts";
import { orderResourcesVisible, routingResourcesVisible, centerResourcesVisible } from "./resource-scope.ts";
export { orderResourcesVisible } from "./resource-scope.ts";
import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import {
  subsidiaryVisibleFilter,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingNotFoundError } from "./errors.ts";
import { getWorkOrder } from "./work-orders.ts";
import { getWorkCenter } from "./work-centers.ts";
import { getRouting } from "./routings.ts";
import { getMrpRun } from "./mrp.ts";
import { lockManufacturingReadAuthority } from "./authority.ts";
import { pendingInspectionHold } from "../inventory/inspection-holds.ts";
import { isUuid } from "../platform/uuid.ts";
import { uuidArray } from "../organization/subsidiaries.ts";

export type ManufacturingView =
  "work-orders" | "work-centers" | "routings" | "mrp";
export type ManufacturingRow = Record<string, unknown> & { id: string };
export type ManufacturingOptions = Record<
  | "items"
  | "subsidiaries"
  | "locations"
  | "centers"
  | "routings"
  | "departments"
  | "calendars"
  | "vendors"
  | "reasons",
  { value: string; label: string; parentId?: string | null }[]
>;
export interface ManufacturingPageData {
  rows: ManufacturingRow[];
  total: number;
  page: number;
  perPage: number;
}
export interface ManufacturingRecordData {
  record: ManufacturingRow;
  sections: Record<string, ManufacturingRow[]>;
}

// Item identities belong to the organization catalog. Legal-entity visibility
// comes from the order and its current resources, not from the item master.
export function manufacturingListQuery(input: {
  page?: number;
  perPage?: number;
  q?: string;
  status?: string;
  subsidiaryId?: string;
  workflow?: string;
  department?: string;
  activeOnly?: boolean;
}) {
  return {
    page: Math.max(1, Math.floor(input.page ?? 1)),
    perPage: Math.min(100, Math.max(10, Math.floor(input.perPage ?? 25))),
    q: input.q?.trim() ?? "",
    status: input.status?.trim() ?? "",
    subsidiaryId: input.subsidiaryId,
    workflow: input.workflow,
    department: input.department,
    activeOnly: input.activeOnly === true,
  };
}

/** Caller scope is explicit on every collection and related-record projection. */
export async function listManufacturingRecords(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  view: ManufacturingView,
  input: Parameters<typeof manufacturingListQuery>[0] = {},
  actorId?: string,
): Promise<ManufacturingPageData> {
  await assertManufacturingFeature(
    tx,
    orgId,
    view === "mrp" ? "manufacturingMrp" : "manufacturing",
  );
  if (actorId) scope = await lockManufacturingReadAuthority(tx,orgId,actorId,scope);
  const query = manufacturingListQuery(input);
  let from: SQL, where: SQL, fields: SQL, order: SQL;
  if (view === "work-orders") {
    from = sql`mfg_work_orders r join items i on i.org_id=r.org_id and i.id=r.produced_item_id`;
    where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`r.subsidiary_id`, scope)} ${orderResourcesVisible(scope, "r")}`;
    where.append(sql` and ${workProfileFilter(sql`${orgId}`,sql`r.operating_profile_version_id`,query.workflow)} and ${workDepartmentFilter(sql`r.operating_department_id`,query.department)}`);
    if (query.activeOnly) where.append(sql` and r.status not in ('done','closed','cancelled')`);
    if (query.subsidiaryId)
      where.append(sql` and r.subsidiary_id=${query.subsidiaryId}`);
    if (query.status) where.append(sql` and r.status=${query.status}`);
    if (query.q)
      where.append(
        sql` and (r.number ilike ${"%" + query.q + "%"} or i.name ilike ${"%" + query.q + "%"} or i.code ilike ${"%" + query.q + "%"} or r.campaign_reference ilike ${"%" + query.q + "%"})`,
      );
    fields = sql`r.id,r.number,r.status,r.priority,i.name as "itemName",i.code as "itemCode",r.quantity_ordered::text as "quantityOrdered",r.quantity_completed::text as "quantityCompleted",r.quantity_scrapped::text as "quantityScrapped",r.unit,r.planned_start::text as "plannedStart",r.planned_end::text as "plannedEnd",r.hold_reason as "holdReason",r.production_mode as "productionMode",r.campaign_reference as "campaignReference"`;
    order = sql`r.created_at desc,r.id`;
  } else if (view === "work-centers") {
    from = sql`mfg_work_centers r`;
    where = sql`r.org_id=${orgId} ${centerResourcesVisible(scope, "r")}`;
    if (query.subsidiaryId)
      where.append(sql` and r.subsidiary_id=${query.subsidiaryId}`);
    if (query.status)
      where.append(sql` and r.is_active=${query.status === "active"}`);
    if (query.q)
      where.append(
        sql` and (r.code ilike ${"%" + query.q + "%"} or r.name ilike ${"%" + query.q + "%"})`,
      );
    fields = sql`r.id,r.code,r.name,r.kind,r.capacity_hours_per_day::text as "capacityHoursPerDay",r.efficiency_pct::text as "efficiencyPct",case when r.is_active then 'active' else 'inactive' end as status`;
    order = sql`r.code,r.id`;
  } else if (view === "routings") {
    from = sql`mfg_routings r join items i on i.org_id=r.org_id and i.id=r.produced_item_id`;
    where = sql`r.org_id=${orgId} ${routingResourcesVisible(scope)}`;
    // A routing is visible only when all of its operation resources are visible.
    if (query.subsidiaryId)
      where.append(sql` and exists (select 1 from mfg_routing_operations operation join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id where operation.org_id=r.org_id and operation.routing_id=r.id and center.subsidiary_id=${query.subsidiaryId})`);
    if (query.status) where.append(sql` and r.status=${query.status}`);
    if (query.q)
      where.append(
        sql` and (r.code ilike ${"%" + query.q + "%"} or r.name ilike ${"%" + query.q + "%"} or i.name ilike ${"%" + query.q + "%"})`,
      );
    fields = sql`r.id,r.code,r.name,r.version,r.status,i.name as "itemName",r.effective_from::text as "effectiveFrom",r.effective_to::text as "effectiveTo"`;
    order = sql`r.code,r.version desc,r.id`;
  } else {
    from = sql`mfg_mrp_runs r`;
    where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`(r.parameters->>'subsidiaryId')::uuid`, scope)}`;
    if (query.subsidiaryId)
      where.append(
        sql` and r.parameters->>'subsidiaryId'=${query.subsidiaryId}`,
      );
    if (query.status) where.append(sql` and r.status=${query.status}`);
    if (query.q) where.append(sql` and r.number ilike ${"%" + query.q + "%"}`);
    fields = sql`r.id,r.number,r.status,r.horizon_start::text as "horizonStart",r.horizon_end::text as "horizonEnd",r.ran_at::text as "ranAt",r.parameters`;
    order = sql`r.ran_at desc nulls last,r.id`;
  }
  const total =
    (
      await tx.execute<{ total: number }>(
        sql`select count(*)::int as total from ${from} where ${where}`,
      )
    ).rows[0]?.total ?? 0;
  const rows = (
    await tx.execute<ManufacturingRow>(
      sql`select ${fields} from ${from} where ${where} order by ${order} limit ${query.perPage} offset ${(query.page - 1) * query.perPage}`,
    )
  ).rows;
  return { rows, total, page: query.page, perPage: query.perPage };
}

export async function manufacturingOptions(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  includeVendors = false,
  actorId?: string,
): Promise<ManufacturingOptions> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  if (actorId) scope = await lockManufacturingReadAuthority(tx,orgId,actorId,scope);
  const result = {} as ManufacturingOptions;
  const select = async (key: keyof ManufacturingOptions, query: SQL) => {
    result[key] = (
      await tx.execute<{
        value: string;
        label: string;
        parentId?: string | null;
      }>(query)
    ).rows;
  };
  await select(
    "items",
    sql`select i.id as value,concat_ws(' · ',i.code,i.name) as label from items i join item_inventory_profiles p on p.org_id=i.org_id and p.item_id=i.id where i.org_id=${orgId} and i.is_active order by i.name,i.id limit 100`,
  );
  await select(
    "subsidiaries",
    sql`select s.id as value,s.name as label from subsidiaries s where s.org_id=${orgId} and s.is_active and not s.is_elimination ${subsidiaryVisibleFilter(sql`s.id`, scope)} order by s.name,s.id`,
  );
  await select(
    "locations",
    sql`select l.id as value,l.code as label from stock_locations l join locations d on d.org_id=l.org_id and d.id=l.location_id where l.org_id=${orgId} and l.is_active and d.is_active ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope, { orgWideNull: true })} order by l.code,l.id limit 100`,
  );
  await select(
    "centers",
    sql`select c.id as value,concat_ws(' · ',c.code,c.name) as label from mfg_work_centers c where c.org_id=${orgId} and c.is_active ${centerResourcesVisible(scope,"c")} order by c.code,c.id limit 100`,
  );
  await select(
    "routings",
    sql`select r.id as value,concat_ws(' · ',r.code,'v' || r.version,r.name) as label,r.produced_item_id as "parentId" from mfg_routings r join items i on i.org_id=r.org_id and i.id=r.produced_item_id where r.org_id=${orgId} and r.status='active' ${routingResourcesVisible(scope)} order by r.code,r.version desc`,
  );
  await select(
    "departments",
    sql`select id as value,name as label from departments where org_id=${orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope, { orgWideNull: true })} order by name,id`,
  );
  await select(
    "calendars",
    sql`select id as value,name as label from schedule_calendars where org_id=${orgId} and project_id is null order by name,id`,
  );
  result.vendors = [];
  if (includeVendors)
    await select(
      "vendors",
      sql`select p.id as value,p.display_name as label from parties p where p.org_id=${orgId} and p.is_active ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope, { orgWideNull: true })} and exists (select 1 from vendor_roles v where v.org_id=p.org_id and v.party_id=p.id ) order by p.display_name,p.id limit 100`,
    );
  await select(
    "reasons",
    sql`select id as value,concat_ws(' · ',code,name) as label,classification as "parentId" from mfg_scrap_reasons where org_id=${orgId} and is_active order by code,id`,
  );
  return result;
}

export async function readManufacturingRecord(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  view: ManufacturingView,
  id: string,
  actorId?: string,
): Promise<ManufacturingRecordData> {
  await assertManufacturingFeature(
    tx,
    orgId,
    view === "mrp" ? "manufacturingMrp" : "manufacturing",
  );
  if (actorId) scope = await lockManufacturingReadAuthority(tx,orgId,actorId,scope);
  const sections: ManufacturingRecordData["sections"] = {};
  const rows = async (key: string, query: SQL) => {
    sections[key] = (await tx.execute<ManufacturingRow>(query)).rows;
  };
  if (view === "work-orders") {
    const record = await getWorkOrder(tx, orgId, id);
    if (!record || !subsidiaryScopeAllows(scope, record.subsidiaryId))
      throw new ManufacturingNotFoundError();
    const item = (
      await tx.execute<ManufacturingRow>(
        sql`select id,name,code from items where org_id=${orgId} and id=${record.producedItemId}`,
      )
    ).rows[0];
    if (!item) throw new ManufacturingNotFoundError();
    // Refuse the whole projection if any current operation or location is outside scope.
    const hidden = (
      await tx.execute<{ id: string }>(
        sql`select r.id from mfg_work_orders r where r.org_id=${orgId} and r.id=${id} and not (true ${orderResourcesVisible(scope, "r")})`,
      )
    ).rows;
    if (hidden.length) throw new ManufacturingNotFoundError();
    if(record.receiptReworkInspectionId) await rows(
      "repairSource",
      sql`select inspection.id,inspection.quantity::text,inspection.lot_id as "lotId",inspection.serial_id as "serialId",inspection.stock_location_id as "locationId",lot.lot_number as "lotNumber",serial.serial_number as "serialNumber"
        from inventory_inspections inspection left join lots lot on lot.org_id=inspection.org_id and lot.id=inspection.lot_id
        left join serials serial on serial.org_id=inspection.org_id and serial.id=inspection.serial_id
        where inspection.org_id=${orgId} and inspection.id=${record.receiptReworkInspectionId} and inspection.rework_work_order_id=${id}`,
    );
    await rows(
      "operations",
      sql`select o.id,o.sequence,o.name,o.status,o.work_center_id as "workCenterId",c.name as "centerName",o.quantity_planned::text as "quantityPlanned",o.quantity_done::text as "quantityDone",o.quantity_scrapped_here::text as "quantityScrappedHere",o.measured_qty::text as "measuredQty",o.quality_gate as "qualityGate",(o.inspection_plan_snapshot is not null) as "inspectionRequired",o.backflush_at as "backflushAt",o.planned_setup_minutes::text as "plannedSetupMinutes",o.planned_run_minutes::text as "plannedRunMinutes",o.actual_setup_minutes::text as "actualSetupMinutes",o.actual_run_minutes::text as "actualRunMinutes",o.actual_labor_minutes::text as "actualLaborMinutes", o.labor_time_source as "laborTimeSource",o.started_at::text as "startedAt",o.completed_at::text as "completedAt",o.pause_reason as "pauseReason" from mfg_wo_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=${orgId} and o.work_order_id=${id} order by o.sequence,o.id`,
    );
    await rows(
      "materials",
      sql`select m.id,m.component_item_id as "itemId",i.name as "itemName",i.code as "itemCode",m.required_qty::text as "requiredQty",m.issued_qty::text as "issuedQty",m.backflush_qty::text as "backflushQty",m.shortage_qty::text as "shortageQty",m.operation_seq as "operationSeq",m.quantity_per::text as "quantityPer",m.quantity_basis as "quantityBasis",m.formula_output_quantity::text as "formulaOutputQuantity",m.lot_serial_policy as tracking,m.waive_reason as "waiveReason",m.waived_at::text as "waivedAt" from mfg_wo_materials m join items i on i.org_id=m.org_id and i.id=m.component_item_id where m.org_id=${orgId} and m.work_order_id=${id} order by i.name,m.id`,
    );
    await rows(
      "byproducts",
      sql`select b.id,b.item_id as "itemId",i.name as "itemName",b.quantity_per::text as "quantityPer",b.quantity_basis as "quantityBasis",b.formula_output_quantity::text as "formulaOutputQuantity",b.output_cost_weight::text as "outputCostWeight",b.standard_cost_snapshot::text as "standardCostSnapshot",case when b.output_cost_weight is null then 'nrv_output' else 'joint_output' end as "outputCostBasis" from mfg_wo_byproducts b join items i on i.org_id=b.org_id and i.id=b.item_id where b.org_id=${orgId} and b.work_order_id=${id} order by i.name,b.id`,
    );
    await rows(
      "scrap",
      sql`select e.id,e.quantity::text,e.classification,e.treatment,e.frozen_value::text as "frozenValue",e.operation_id as "operationId",e.component_item_id as "itemId",r.name as "reasonName",e.posted_entry_id as "entryId",e.disposition_change_id as "changeId",e.created_at::text as "createdAt" from mfg_scrap_events e join mfg_scrap_reasons r on r.org_id=e.org_id and r.id=e.reason_id where e.org_id=${orgId} and e.work_order_id=${id} order by e.created_at desc,e.id`,
    );
    await rows(
      "receipts",
      sql`select m.id,i.name as "itemName",m.quantity::text,p.base_unit as unit,m.stock_location_id as "locationId",l.code as location,m.lot_id as "lotId",m.serial_id as "serialId",t.lot_number as "lotNumber",s.serial_number as "serialNumber",m.journal_entry_id as "entryId",e.status,m.created_at::text as "createdAt" from inventory_movements m join journal_entries e on e.org_id=m.org_id and e.id=m.journal_entry_id join items i on i.org_id=m.org_id and i.id=m.item_id join item_inventory_profiles p on p.org_id=m.org_id and p.item_id=m.item_id join stock_locations l on l.org_id=m.org_id and l.id=m.stock_location_id left join lots t on t.org_id=m.org_id and t.id=m.lot_id left join serials s on s.org_id=m.org_id and s.id=m.serial_id where m.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} and m.kind='assembly_build' ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by m.created_at desc,m.id`,
    );
    await rows(
      "issues",
      sql`select m.id,i.name as "itemName",(-m.quantity)::text as quantity,p.base_unit as unit,l.code as location,m.lot_id as "lotId",m.serial_id as "serialId",t.lot_number as "lotNumber",s.serial_number as "serialNumber",m.journal_entry_id as "entryId",e.status,(-m.quantity-coalesce((select sum(allocation.quantity) from mfg_completion_inputs allocation join journal_entries receipt on receipt.org_id=allocation.org_id and receipt.id=allocation.completion_entry_id where allocation.org_id=m.org_id and allocation.input_movement_id=m.id and receipt.status='posted' and receipt.reverses_entry_id is null),0))::text as "unassignedQty",
      not exists(select 1 from inventory_movements reversal where reversal.org_id=m.org_id and reversal.reverses_movement_id=m.id and reversal.status='posted') as "liveIssue",m.created_at::text as "createdAt" from inventory_movements m join journal_entries e on e.org_id=m.org_id and e.id=m.journal_entry_id join items i on i.org_id=m.org_id and i.id=m.item_id join item_inventory_profiles p on p.org_id=m.org_id and p.item_id=m.item_id join stock_locations l on l.org_id=m.org_id and l.id=m.stock_location_id left join lots t on t.org_id=m.org_id and t.id=m.lot_id left join serials s on s.org_id=m.org_id and s.id=m.serial_id where m.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} and m.kind='assembly_consume' ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by m.created_at desc,m.id`,
    );
    await rows('materialBalance',sql`select profile.base_unit as id,profile.base_unit as unit,
      coalesce(sum(-movement.quantity) filter(where movement.kind='assembly_consume'),0)::text as "inputQuantity",
      coalesce(sum(movement.quantity) filter(where movement.kind='assembly_build'),0)::text as "outputQuantity",
      (-sum(movement.quantity))::text as difference
      from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
      join item_inventory_profiles profile on profile.org_id=movement.org_id and profile.item_id=movement.item_id
      where movement.org_id=${orgId} and entry.origin='manufacturing' and entry.custom->>'work_order_number'=${record.number}
        and entry.status='posted' and entry.reverses_entry_id is null and movement.status='posted' and movement.reverses_movement_id is null
        and movement.kind in('assembly_consume','assembly_build') and not exists(select 1 from inventory_movements reversal where reversal.org_id=movement.org_id and reversal.reverses_movement_id=movement.id and reversal.status='posted')
        ${subsidiaryVisibleFilter(sql`entry.subsidiary_id`,scope)} group by profile.base_unit order by profile.base_unit`);
    await rows(
      "entries",
      sql`select e.id,e.entry_number as number,e.posting_date::text as date,e.status,e.memo,e.custom from journal_entries e where e.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by e.created_at desc,e.id limit 200`,
    );
    await rows(
      "children",
      sql`select c.id,c.number,c.status,c.quantity_ordered::text as quantity,c.unit from mfg_work_orders c where c.org_id=${orgId} and c.parent_wo_id=${id} ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)} ${orderResourcesVisible(scope, "c")} order by c.number,c.id`,
    );
    const entity = (
      await tx.execute<{ currency: string }>(
        sql`select base_currency as currency from subsidiaries where org_id=${orgId} and id=${record.subsidiaryId}`,
      )
    ).rows[0];
    return {
      record: {
        ...record,
        operatingProfile: await readPinnedOperatingProfile(tx,orgId,record.operatingProfileVersionId,"production"),
        itemName: item.name,
        itemCode: item.code,
        currency: entity?.currency,
      },
      sections,
    };
  }
  if (view === "work-centers") {
    const record = await getWorkCenter(tx, orgId, id);
    if (
      !record ||
      !subsidiaryScopeAllows(scope, record.subsidiaryId as string | null)
    )
      throw new ManufacturingNotFoundError();
    if (!(await tx.execute(sql`select r.id from mfg_work_centers r where r.org_id=${orgId} and r.id=${id} ${centerResourcesVisible(scope,"r")}`)).rows.length)
      throw new ManufacturingNotFoundError();
    await rows(
      "rates",
      sql`select id,machine_rate_per_hour::text as "machineRatePerHour",effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo" from mfg_work_center_rates where org_id=${orgId} and work_center_id=${id} order by effective_from desc,id`,
    );
    return { record: record as ManufacturingRow, sections };
  }
  if (view === "routings") {
    const record = await getRouting(tx, orgId, id);
    if (
      !record ||
      record.operations?.some(
        (o) => !subsidiaryScopeAllows(scope, o.workCenterSubsidiaryId),
      )
    )
      throw new ManufacturingNotFoundError();
    const visible = (await tx.execute(sql`select r.id from mfg_routings r where r.org_id=${orgId} and r.id=${id} ${routingResourcesVisible(scope)}`)).rows;
    if (!visible.length) throw new ManufacturingNotFoundError();
    await rows(
      "operations",
      sql`select o.id,o.sequence,o.name,o.work_center_id as "workCenterId",c.name as "centerName",
      o.setup_minutes::text as "setupMinutes",o.run_minutes_per_unit::text as "runMinutesPerUnit",o.labor_minutes_per_unit::text as "laborMinutesPerUnit",
      o.backflush_at as "backflushAt",o.quality_gate as "qualityGate"
      from mfg_routing_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id
      where o.org_id=${orgId} and o.routing_id=${id} order by o.sequence,o.id`,
    );
    await rows(
      "versions",
      sql`select v.id,v.code,v.name,v.version,v.status,v.effective_from::text as "effectiveFrom",v.effective_to::text as "effectiveTo" from mfg_routings v where v.org_id=${orgId} and v.produced_item_id=${record.producedItemId} ${routingResourcesVisible(scope, "v")} order by v.version desc,v.id`,
    );
    return { record: record as ManufacturingRow, sections };
  }
  // Scope is checked before loading suggestions or capacity.
  const run = (
    await tx.execute<ManufacturingRow>(
      sql`select id,parameters from mfg_mrp_runs where org_id=${orgId} and id=${id}`,
    )
  ).rows[0];
  if (
    !run ||
    !subsidiaryScopeAllows(
      scope,
      (run.parameters as { subsidiaryId?: string }).subsidiaryId,
    )
  )
    throw new ManufacturingNotFoundError();
  const result = await getMrpRun(tx, orgId, id,scope);
  sections.suggestions = result.suggestions as ManufacturingRow[];
  sections.capacity = result.capacity.map((c) => ({
    ...c,
    id: c.workCenterId + ":" + c.weekStart,
  }));
  return { record: {...result.run,capacityEvidence:result.capacityEvidence} as ManufacturingRow, sections };
}

/** Identifiers are offered as choices; availability and holds remain command-time invariants. */
export async function manufacturingTracking(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  itemId: string,
  query: { q?: string; selected?: string; lotId?: string } = {},
  actorId?:string,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  if (!isUuid(itemId) || [query.selected,query.lotId].some(value=>value!==undefined&&!isUuid(value)) || (query.q!==undefined&&(typeof query.q!=='string'||query.q.length>200))) throw new ManufacturingNotFoundError();
  if (actorId) scope=await lockManufacturingReadAuthority(tx,orgId,actorId,scope,['manufacturing.read','items.read']);
  if (!(await tx.execute(sql`select id from items where org_id=${orgId} and id=${itemId}`)).rows.length) throw new ManufacturingNotFoundError();
  if (scope!==null&&!scope.size) return {lots:[],serials:[]};
  const pattern='%'+(query.q??'').trim()+'%';
  const positions=sql`positions as (
    select lot_id,serial_id,subsidiary_id from inventory_movements where org_id=${orgId} and item_id=${itemId}
    union all select lot_id,serial_id,subsidiary_id from consignment_stock where org_id=${orgId} and item_id=${itemId})`;
  // Tenant-wide identifiers may span entities. A restricted choice must reveal no foreign ownership.
  const lotVisible=scope===null?sql`true`:sql`exists(select 1 from positions owner where owner.lot_id=lot.id and owner.subsidiary_id=any(${uuidArray([...scope])}::uuid[]))
    and not exists(select 1 from positions owner where owner.lot_id=lot.id and (owner.subsidiary_id is null or not(owner.subsidiary_id=any(${uuidArray([...scope])}::uuid[]))))`;
  const serialVisible=scope===null?sql`true`:sql`exists(select 1 from positions owner where owner.serial_id=serial.id and owner.subsidiary_id=any(${uuidArray([...scope])}::uuid[]))
    and not exists(select 1 from positions owner where owner.serial_id=serial.id and (owner.subsidiary_id is null or not(owner.subsidiary_id=any(${uuidArray([...scope])}::uuid[]))))`;
  const lots=(await tx.execute<{value:string;label:string}>(sql`with ${positions} select lot.id as value,lot.lot_number as label from lots lot
    where lot.org_id=${orgId} and lot.item_id=${itemId} and lot.hold_reason is null and ${lotVisible}
    and not ${pendingInspectionHold(sql`lot.org_id`,sql`lot.id`,sql`null::uuid`)} and (lot.lot_number ilike ${pattern} ${query.selected?sql`or lot.id=${query.selected}`:sql``})
    order by ${query.selected?sql`(lot.id=${query.selected}) desc,`:sql``} lot.lot_number,lot.id limit 100`)).rows;
  if(query.lotId && !(await tx.execute(sql`with ${positions} select lot.id from lots lot where lot.org_id=${orgId} and lot.item_id=${itemId} and lot.id=${query.lotId} and ${lotVisible}`)).rows.length) throw new ManufacturingNotFoundError();
  const serials=(await tx.execute<{value:string;label:string;parentId:string|null}>(sql`with ${positions} select serial.id as value,serial.serial_number as label,serial.lot_id as "parentId" from serials serial
    join stock_locations stock on stock.org_id=serial.org_id and stock.id=serial.current_stock_location_id
    join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    left join lots lot on lot.org_id=serial.org_id and lot.id=serial.lot_id
    where serial.org_id=${orgId} and serial.item_id=${itemId} and serial.status='in_stock' and serial.hold_reason is null and lot.hold_reason is null and ${serialVisible}
    and (serial.lot_id is null or ${lotVisible}) and not ${pendingInspectionHold(sql`serial.org_id`,sql`serial.lot_id`,sql`serial.id`)}
    ${query.lotId?sql`and serial.lot_id=${query.lotId}`:sql``} and (serial.serial_number ilike ${pattern} ${query.selected?sql`or serial.id=${query.selected}`:sql``})
    ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}
    order by ${query.selected?sql`(serial.id=${query.selected}) desc,`:sql``} serial.serial_number,serial.id limit 100`)).rows;
  return {lots,serials};
}

export type ManufacturingChoiceKind = "items" | "locations" | "vendors" | "centers";

/** Search the authoritative scoped collection rather than limiting selection to preload rows. */
export async function searchManufacturingChoices(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  kind: ManufacturingChoiceKind,
  q = "",
  selected?: string,
  actorId?: string,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  if (actorId) scope = await lockManufacturingReadAuthority(tx,orgId,actorId,scope);
  const pattern = "%" + q.trim().slice(0, 200) + "%";
  let query: SQL;
  if (kind === "items") {
    query = sql`select i.id as value, concat_ws(' · ',i.code,i.name) as label
      from items i join item_inventory_profiles p on p.org_id=i.org_id and p.item_id=i.id
      where i.org_id=${orgId} and i.is_active
      and (i.name ilike ${pattern} or i.code ilike ${pattern} ${selected ? sql`or i.id=${selected}` : sql``})
      order by ${selected ? sql`(i.id=${selected}) desc,` : sql``} i.name,i.id limit 100`;
  } else if (kind === "centers") {
    query = sql`select c.id as value,concat_ws(' · ',c.code,c.name) as label from mfg_work_centers c
      where c.org_id=${orgId} and c.is_active ${centerResourcesVisible(scope,"c")}
      and (c.code ilike ${pattern} or c.name ilike ${pattern} ${selected?sql`or c.id=${selected}`:sql``})
      order by ${selected?sql`(c.id=${selected}) desc,`:sql``} c.code,c.id limit 100`;
  } else if (kind === "locations") {
    query = sql`select l.id as value,l.code as label from stock_locations l
      join locations d on d.org_id=l.org_id and d.id=l.location_id
      where l.org_id=${orgId} and l.is_active and d.is_active
      ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope, { orgWideNull: true })}
      and (l.code ilike ${pattern} ${selected ? sql`or l.id=${selected}` : sql``})
      order by ${selected ? sql`(l.id=${selected}) desc,` : sql``} l.code,l.id limit 100`;
  } else {
    query = sql`select p.id as value,p.display_name as label from parties p
      where p.org_id=${orgId} and p.is_active
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope, { orgWideNull: true })}
      and exists(select 1 from vendor_roles v where v.org_id=p.org_id and v.party_id=p.id)
      and (p.display_name ilike ${pattern} ${selected ? sql`or p.id=${selected}` : sql``})
      order by ${selected ? sql`(p.id=${selected}) desc,` : sql``} p.display_name,p.id limit 100`;
  }
  return (await tx.execute<{ value: string; label: string }>(query)).rows;
}

/** Bounded shared-time references use the same whole-order resource fence as the production workspace. */
export async function searchProductionTimeChoices(tx: SqlExecutor, orgId: string, scope: ReadonlySet<string> | null, input: {
  q?: string; selected?: string; workOrderId?: string;
}) {
  await assertManufacturingFeature(tx, orgId, 'manufacturing')
  const where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`r.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'r')}`
  const term = `%${input.q?.trim() ?? ''}%`
  if (input.workOrderId) {
    where.append(sql` and r.id=${input.workOrderId}`)
    return (await tx.execute<{ value: string; label: string }>(sql`
      select o.id as value,concat_ws(' · ',o.sequence::text,o.name,c.name) as label from mfg_work_orders r
      join mfg_wo_operations o on o.org_id=r.org_id and o.work_order_id=r.id
      join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id
      where ${where} and ((r.status in ('released','in_progress') and o.status<>'done') or o.id=${input.selected ?? null})
      and (o.id=${input.selected ?? null} or o.name ilike ${term} or c.name ilike ${term})
      order by (o.id=${input.selected ?? null}) desc nulls last,o.sequence,o.id limit 50`)).rows
  }
  return (await tx.execute<{ value: string; label: string }>(sql`
    select r.id as value,concat_ws(' · ',r.number,i.name) as label from mfg_work_orders r join items i on i.org_id=r.org_id and i.id=r.produced_item_id
    where ${where} and (r.status in ('released','in_progress') or r.id=${input.selected ?? null})
    and (r.id=${input.selected ?? null} or r.number ilike ${term} or i.name ilike ${term})
    order by (r.id=${input.selected ?? null}) desc nulls last,r.number,r.id limit 50`)).rows
}
