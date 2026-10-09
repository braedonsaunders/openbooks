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

export function manufacturingListQuery(input: {
  page?: number;
  perPage?: number;
  q?: string;
  status?: string;
  subsidiaryId?: string;
}) {
  return {
    page: Math.max(1, Math.floor(input.page ?? 1)),
    perPage: Math.min(100, Math.max(10, Math.floor(input.perPage ?? 25))),
    q: input.q?.trim() ?? "",
    status: input.status?.trim() ?? "",
    subsidiaryId: input.subsidiaryId,
  };
}

/** Caller scope is explicit on every collection and related-record projection. */
export async function listManufacturingRecords(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  view: ManufacturingView,
  input: Parameters<typeof manufacturingListQuery>[0] = {},
): Promise<ManufacturingPageData> {
  await assertManufacturingFeature(
    tx,
    orgId,
    view === "mrp" ? "manufacturingMrp" : "manufacturing",
  );
  const query = manufacturingListQuery(input);
  let from: SQL, where: SQL, fields: SQL, order: SQL;
  if (view === "work-orders") {
    from = sql`mfg_work_orders r join items i on i.org_id=r.org_id and i.id=r.produced_item_id`;
    where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`r.subsidiary_id`, scope)} ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}`;
    if (query.subsidiaryId)
      where.append(sql` and r.subsidiary_id=${query.subsidiaryId}`);
    if (query.status) where.append(sql` and r.status=${query.status}`);
    if (query.q)
      where.append(
        sql` and (r.number ilike ${"%" + query.q + "%"} or i.name ilike ${"%" + query.q + "%"} or i.code ilike ${"%" + query.q + "%"})`,
      );
    fields = sql`r.id,r.number,r.status,r.priority,i.name as "itemName",i.code as "itemCode",r.quantity_ordered::text as "quantityOrdered",r.quantity_completed::text as "quantityCompleted",r.quantity_scrapped::text as "quantityScrapped",r.unit,r.planned_start::text as "plannedStart",r.planned_end::text as "plannedEnd",r.hold_reason as "holdReason"`;
    order = sql`r.created_at desc,r.id`;
  } else if (view === "work-centers") {
    from = sql`mfg_work_centers r`;
    where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`r.subsidiary_id`, scope)}`;
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
    where = sql`r.org_id=${orgId} ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}`;
    // A routing is visible only when all of its operation resources are visible.
    where.append(
      sql` and not exists (select 1 from mfg_routing_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=r.org_id and o.routing_id=r.id and not (true ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)}))`,
    );
    if (query.subsidiaryId)
      where.append(sql` and i.subsidiary_id=${query.subsidiaryId}`);
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
): Promise<ManufacturingOptions> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
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
    sql`select i.id as value,concat_ws(' · ',i.code,i.name) as label from items i join item_inventory_profiles p on p.org_id=i.org_id and p.item_id=i.id where i.org_id=${orgId} and i.is_active ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)} order by i.name,i.id limit 100`,
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
    sql`select c.id as value,concat_ws(' · ',c.code,c.name) as label from mfg_work_centers c where c.org_id=${orgId} and c.is_active ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)} order by c.code,c.id`,
  );
  await select(
    "routings",
    sql`select r.id as value,concat_ws(' · ',r.code,'v' || r.version,r.name) as label,r.produced_item_id as "parentId" from mfg_routings r join items i on i.org_id=r.org_id and i.id=r.produced_item_id where r.org_id=${orgId} and r.status='active' ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)} and not exists (select 1 from mfg_routing_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=r.org_id and o.routing_id=r.id and not (true ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)})) order by r.code,r.version desc`,
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
): Promise<ManufacturingRecordData> {
  await assertManufacturingFeature(
    tx,
    orgId,
    view === "mrp" ? "manufacturingMrp" : "manufacturing",
  );
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
        sql`select id,name,code,subsidiary_id as "subsidiaryId" from items where org_id=${orgId} and id=${record.producedItemId}`,
      )
    ).rows[0];
    if (
      !item ||
      !subsidiaryScopeAllows(scope, item.subsidiaryId as string | null)
    )
      throw new ManufacturingNotFoundError();
    // Refuse the whole projection if a child resource or component is outside scope.
    const hidden = (
      await tx.execute<{ id: string }>(
        sql`select o.id from mfg_wo_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=${orgId} and o.work_order_id=${id} and not (true ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)}) union all select m.id from mfg_wo_materials m join items i on i.org_id=m.org_id and i.id=m.component_item_id where m.org_id=${orgId} and m.work_order_id=${id} and not (true ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}) union all select b.id from mfg_wo_byproducts b join items i on i.org_id=b.org_id and i.id=b.item_id where b.org_id=${orgId} and b.work_order_id=${id} and not (true ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}) limit 1`,
      )
    ).rows;
    if (hidden.length) throw new ManufacturingNotFoundError();
    await rows(
      "operations",
      sql`select o.id,o.sequence,o.name,o.status,o.work_center_id as "workCenterId",c.name as "centerName",o.quantity_planned::text as "quantityPlanned",o.quantity_done::text as "quantityDone",o.quantity_scrapped_here::text as "quantityScrappedHere",o.measured_qty::text as "measuredQty",o.quality_gate as "qualityGate",o.backflush_at as "backflushAt",o.planned_setup_minutes::text as "plannedSetupMinutes",o.planned_run_minutes::text as "plannedRunMinutes",o.actual_setup_minutes::text as "actualSetupMinutes",o.actual_run_minutes::text as "actualRunMinutes",o.actual_labor_minutes::text as "actualLaborMinutes",o.started_at::text as "startedAt",o.completed_at::text as "completedAt",o.pause_reason as "pauseReason" from mfg_wo_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=${orgId} and o.work_order_id=${id} order by o.sequence,o.id`,
    );
    await rows(
      "materials",
      sql`select m.id,m.component_item_id as "itemId",i.name as "itemName",i.code as "itemCode",m.required_qty::text as "requiredQty",m.issued_qty::text as "issuedQty",m.backflush_qty::text as "backflushQty",m.shortage_qty::text as "shortageQty",m.operation_seq as "operationSeq",m.lot_serial_policy as tracking,m.waive_reason as "waiveReason",m.waived_at::text as "waivedAt" from mfg_wo_materials m join items i on i.org_id=m.org_id and i.id=m.component_item_id where m.org_id=${orgId} and m.work_order_id=${id} order by i.name,m.id`,
    );
    await rows(
      "byproducts",
      sql`select b.id,b.item_id as "itemId",i.name as "itemName",b.quantity_per::text as "quantityPer" from mfg_wo_byproducts b join items i on i.org_id=b.org_id and i.id=b.item_id where b.org_id=${orgId} and b.work_order_id=${id} order by i.name,b.id`,
    );
    await rows(
      "scrap",
      sql`select e.id,e.quantity::text,e.classification,e.treatment,e.frozen_value::text as "frozenValue",e.operation_id as "operationId",e.component_item_id as "itemId",r.name as "reasonName",e.posted_entry_id as "entryId",e.created_at::text as "createdAt" from mfg_scrap_events e join mfg_scrap_reasons r on r.org_id=e.org_id and r.id=e.reason_id where e.org_id=${orgId} and e.work_order_id=${id} order by e.created_at desc,e.id`,
    );
    await rows(
      "receipts",
      sql`select m.id,i.name as "itemName",m.quantity::text,p.base_unit as unit,m.stock_location_id as "locationId",l.code as location,t.lot_number as "lotNumber",s.serial_number as "serialNumber",m.journal_entry_id as "entryId",e.status,m.created_at::text as "createdAt" from inventory_movements m join journal_entries e on e.org_id=m.org_id and e.id=m.journal_entry_id join items i on i.org_id=m.org_id and i.id=m.item_id join item_inventory_profiles p on p.org_id=m.org_id and p.item_id=m.item_id join stock_locations l on l.org_id=m.org_id and l.id=m.stock_location_id left join lots t on t.org_id=m.org_id and t.id=m.lot_id left join serials s on s.org_id=m.org_id and s.id=m.serial_id where m.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} and m.kind='assembly_build' ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by m.created_at desc,m.id`,
    );
    await rows(
      "issues",
      sql`select m.id,i.name as "itemName",(-m.quantity)::text as quantity,p.base_unit as unit,l.code as location,t.lot_number as "lotNumber",s.serial_number as "serialNumber",m.journal_entry_id as "entryId",e.status,m.created_at::text as "createdAt" from inventory_movements m join journal_entries e on e.org_id=m.org_id and e.id=m.journal_entry_id join items i on i.org_id=m.org_id and i.id=m.item_id join item_inventory_profiles p on p.org_id=m.org_id and p.item_id=m.item_id join stock_locations l on l.org_id=m.org_id and l.id=m.stock_location_id left join lots t on t.org_id=m.org_id and t.id=m.lot_id left join serials s on s.org_id=m.org_id and s.id=m.serial_id where m.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} and m.kind='assembly_consume' ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by m.created_at desc,m.id`,
    );
    await rows(
      "entries",
      sql`select e.id,e.entry_number as number,e.posting_date::text as date,e.status,e.memo,e.custom from journal_entries e where e.org_id=${orgId} and e.origin='manufacturing' and e.custom->>'work_order_number'=${record.number} ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, scope)} order by e.created_at desc,e.id limit 200`,
    );
    await rows(
      "children",
      sql`select c.id,c.number,c.status,c.quantity_ordered::text as quantity,c.unit from mfg_work_orders c where c.org_id=${orgId} and c.parent_wo_id=${id} ${subsidiaryVisibleFilter(sql`c.subsidiary_id`, scope)} order by c.number,c.id`,
    );
    const entity = (
      await tx.execute<{ currency: string }>(
        sql`select base_currency as currency from subsidiaries where org_id=${orgId} and id=${record.subsidiaryId}`,
      )
    ).rows[0];
    return {
      record: {
        ...record,
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
      !subsidiaryScopeAllows(scope, record.producedItemSubsidiaryId) ||
      record.operations?.some(
        (o) => !subsidiaryScopeAllows(scope, o.workCenterSubsidiaryId),
      )
    )
      throw new ManufacturingNotFoundError();
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
      sql`select id,code,name,version,status,effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo" from mfg_routings where org_id=${orgId} and produced_item_id=${record.producedItemId} order by version desc,id`,
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
  const hidden = (
    await tx.execute(
      sql`select p.id from mfg_planned_orders p join items i on i.org_id=p.org_id and i.id=p.item_id where p.org_id=${orgId} and p.run_id=${id} and not (true ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}) limit 1`,
    )
  ).rows;
  if (hidden.length) throw new ManufacturingNotFoundError();
  const result = await getMrpRun(tx, orgId, id);
  sections.suggestions = result.suggestions as ManufacturingRow[];
  sections.capacity = result.capacity.map((c) => ({
    ...c,
    id: c.workCenterId + ":" + c.weekStart,
  }));
  return { record: result.run as ManufacturingRow, sections };
}

/** Identifiers are offered as choices; availability and holds remain command-time invariants. */
export async function manufacturingTracking(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  itemId: string,
  query: { q?: string; selected?: string; lotId?: string } = {},
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const item = (
    await tx.execute(
      sql`select id from items where org_id=${orgId} and id=${itemId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)}`,
    )
  ).rows[0];
  if (!item) throw new ManufacturingNotFoundError();
  const pattern = "%" + (query.q ?? "").trim().slice(0, 200) + "%";
  const lots = (
    await tx.execute<{ value: string; label: string }>(
      sql`select id as value,lot_number as label from lots where org_id=${orgId} and item_id=${itemId} and hold_reason is null and (lot_number ilike ${pattern} ${query.selected ? sql`or id=${query.selected}` : sql``}) order by ${query.selected ? sql`(id=${query.selected}) desc,` : sql``} lot_number,id limit 100`,
    )
  ).rows;
  const serials = (
    await tx.execute<{ value: string; label: string; parentId: string | null }>(
      sql`select s.id as value,s.serial_number as label,s.lot_id as "parentId" from serials s join stock_locations l on l.org_id=s.org_id and l.id=s.current_stock_location_id join locations d on d.org_id=l.org_id and d.id=l.location_id where s.org_id=${orgId} and s.item_id=${itemId} and s.status='in_stock' and s.hold_reason is null ${query.lotId ? sql`and s.lot_id=${query.lotId}` : sql``} and (s.serial_number ilike ${pattern} ${query.selected ? sql`or s.id=${query.selected}` : sql``}) ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope, { orgWideNull: true })} order by ${query.selected ? sql`(s.id=${query.selected}) desc,` : sql``} s.serial_number,s.id limit 100`,
    )
  ).rows;
  return { lots, serials };
}

export type ManufacturingChoiceKind = "items" | "locations" | "vendors";

/** Search the authoritative scoped collection rather than limiting selection to preload rows. */
export async function searchManufacturingChoices(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
  kind: ManufacturingChoiceKind,
  q = "",
  selected?: string,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const pattern = "%" + q.trim().slice(0, 200) + "%";
  let query: SQL;
  if (kind === "items") {
    query = sql`select i.id as value, concat_ws(' · ',i.code,i.name) as label
      from items i join item_inventory_profiles p on p.org_id=i.org_id and p.item_id=i.id
      where i.org_id=${orgId} and i.is_active ${subsidiaryVisibleFilter(sql`i.subsidiary_id`, scope)}
      and (i.name ilike ${pattern} or i.code ilike ${pattern} ${selected ? sql`or i.id=${selected}` : sql``})
      order by ${selected ? sql`(i.id=${selected}) desc,` : sql``} i.name,i.id limit 100`;
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
