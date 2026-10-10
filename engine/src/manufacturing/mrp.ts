import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, div, fromUnits, mul, mulPercent, neg, toUnits } from "../money/money.ts";
import { getAvailableToPromise, stockedItems } from "../inventory/availability.ts";
import { toBaseQuantity } from "../inventory/costing.ts";
import { bomRequiredQuantity, type BomQuantityBasis } from "../inventory/bom-scrap.ts";
import { createTransferOrder } from "../inventory/transfer-orders.ts";
import type { Runner } from "../inventory/contracts.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { openQuantitySql } from "../records/order-line-remainders.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange } from "./master-support.ts";
import { explodeBom } from "./bom-explode.ts";
import { createWorkOrder } from "./work-orders.ts";
import { lockManufacturingManageAuthority,lockManufacturingReadAuthority } from "./authority.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { routingResourcesVisible,orderResourcesVisible,centerResourcesVisible } from "./resource-scope.ts";
import { documentResourcesVisible } from "../organization/production-resource-scope.ts";
import { isUuid } from "../platform/uuid.ts";

async function lockPlanningAuthority(tx:SqlExecutor,orgId:string,actorId:string,subsidiaryId:string,extraPermission?:string) {
  if(!isUuid(subsidiaryId)) throw new ManufacturingNotFoundError();
  let scope=await lockManufacturingManageAuthority(tx,orgId,actorId,subsidiaryId);
  scope=await lockManufacturingReadAuthority(tx,orgId,actorId,scope,['items.read']);
  if(extraPermission) {
    const extra=await lockActorCommandAuthority(tx,orgId,actorId,subsidiaryId,extraPermission);
    if(extra!==null) scope=scope===null?extra:new Set([...scope].filter(id=>extra.has(id)));
  }
  if(scope!==null&&!scope.has(subsidiaryId)) throw new ManufacturingNotFoundError();
  // Planning a whole entity cannot reveal quantities at hidden related locations.
  if(scope!==null && (await tx.execute(sql`select movement.id from inventory_movements movement
    left join stock_locations stock on stock.org_id=movement.org_id and stock.id=movement.stock_location_id
    left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where movement.org_id=${orgId} and movement.subsidiary_id=${subsidiaryId}
      and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})})) limit 1`)).rows.length) throw new ManufacturingNotFoundError();
  if((await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.subsidiary_id=${subsidiaryId}
    and work.status in('released','in_progress') and not(true ${orderResourcesVisible(scope,'work')}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  if((await tx.execute(sql`select document.id from documents document where document.org_id=${orgId} and document.subsidiary_id=${subsidiaryId}
    and document.kind in('sales_order','purchase_order') and document.status='approved'
    and exists(select 1 from document_lines dl where dl.org_id=document.org_id and dl.document_id=document.id and ${openQuantitySql('dl')}>0)
    and not(${documentResourcesVisible(scope,'document')}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  return scope;
}

const REMEDY_LEAD = "set a lead time in the item's manufacturing policy";
const decimal = (value: string) => toUnits(value);
const from = (value: bigint) => fromUnits(value);
const itemLabel = (code: string | null | undefined, name: string) => code?.trim() || name;

function refuse(message: string, code: string, remedy: string, status = 409): never {
  throw new ManufacturingError(message, { status, code, remedy });
}

function roundToMultiple(quantity: string, multiple: string): string {
  const q = decimal(quantity);
  const m = decimal(multiple);
  if (m <= 0n) return from(q);
  return from(((q + m - 1n) / m) * m);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monday(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Demand = {
  itemId: string;
  quantity: string;
  dueDate: string;
  demandRef: Record<string, unknown>;
  itemCode: string;
};
type Policy = {
  itemId: string;
  itemCode: string;
  supplyMethod: "make" | "buy" | "transfer";
  leadTimeDays: number | null;
  safetyStockQty: string;
  minimumQty: string;
  orderMultipleQty: string;
  updatedAt: string;
};
type Planned = Demand & {
  plannedStart: string;
  action: Policy["supplyMethod"];
  isExpedite: boolean;
};
type Receipt = { itemId: string; quantity: string; dueDate: string; type: string };

export interface RunMrpOptions {
  subsidiaryId: string;
  horizonDays?: number;
  capacityCheck?: boolean;
}

export interface MrpRun extends Record<string, unknown> {
  id: string;
  number: string;
  horizonStart: string;
  horizonEnd: string;
  status: "draft" | "complete" | "superseded";
  parameters: Record<string, unknown>;
  ranAt: string | null;
}

export interface MrpPlannedOrder extends Record<string, unknown> {
  id: string;
  runId: string;
  itemId: string;
  itemCode: string;
  quantity: string;
  dueDate: string;
  plannedStart: string | null;
  action: "make" | "buy" | "transfer";
  demandRef: Record<string, unknown>;
  status: "suggested" | "confirmed" | "converted" | "dismissed";
  convertedRefId: string | null;
  isExpedite: boolean;
  dismissReason: string | null;
}

type ItemCode = { id: string; code: string | null; name: string };
type PolicyRow = {
  item_id: string; supply_method: Policy["supplyMethod"]; lead_time_days: number | null;
  safety_stock_qty: string; minimum_qty: string; order_multiple_qty: string; updated_at: string;
};

async function demandAndSupply(tx: SqlExecutor, orgId: string, subsidiaryId: string, horizonEnd: string) {
  // The order-progress reader includes approved documents only; draft, pending_approval, posted, and voided documents are not open sales-order demand.
  const demandRows = (await tx.execute<{
    item_id: string; item_code: string | null; item_name: string; line_id: string;
    document_id: string; document_number: string; line_number: number; due_date: string;
    quantity: string; unit: string | null;
  }>(sql`
    select dl.item_id, i.code as item_code, i.name as item_name, dl.id as line_id,
           d.id as document_id, d.document_number, dl.line_number,
           coalesce(d.due_date, d.document_date)::text as due_date,
           ${openQuantitySql("dl")}::text as quantity, dl.unit
      from documents d
      join document_lines dl on dl.org_id=d.org_id and dl.document_id=d.id
      join items i on i.org_id=dl.org_id and i.id=dl.item_id
     where d.org_id=${orgId} and d.kind='sales_order' and d.status='approved'
       and d.subsidiary_id=${subsidiaryId}
       and coalesce(d.due_date, d.document_date) <= ${horizonEnd}::date
       and ${openQuantitySql("dl")} > 0
     order by coalesce(d.due_date, d.document_date), i.code, d.document_number, dl.line_number`)).rows;
  const itemIds = [...new Set(demandRows.map((row) => row.item_id))];
  const orderLines = (await tx.execute<{
    item_id: string; due_date: string; quantity: string; unit: string | null;
  }>(sql`
    select dl.item_id, coalesce(d.due_date, d.document_date)::text as due_date,
           ${openQuantitySql("dl")}::text as quantity, dl.unit
      from documents d join document_lines dl on dl.org_id=d.org_id and dl.document_id=d.id
     where d.org_id=${orgId} and d.kind='purchase_order' and d.status='approved'
       and d.subsidiary_id=${subsidiaryId}
       and coalesce(d.due_date, d.document_date) <= ${horizonEnd}::date
       and ${openQuantitySql("dl")} > 0`)).rows;
  const policies = (await tx.execute<PolicyRow>(sql`
    select p.item_id, p.supply_method, p.lead_time_days, p.safety_stock_qty::text,
           p.minimum_qty::text, p.order_multiple_qty::text, p.updated_at::text
      from mfg_item_policies p join items i on i.org_id=p.org_id and i.id=p.item_id
     where p.org_id=${orgId}
     order by i.code, p.item_id`)).rows;
  const workOrders = (await tx.execute<{
    item_id: string; due_date: string; quantity: string;
  }>(sql`
    select produced_item_id as item_id,
           coalesce(planned_end, planned_start, ${await businessToday(orgId)}::date)::text as due_date,
           (quantity_ordered-quantity_completed)::text as quantity
      from mfg_work_orders
     where org_id=${orgId} and subsidiary_id=${subsidiaryId}
       and status in ('released','in_progress') and quantity_ordered > quantity_completed`)).rows;
  const reservations = (await tx.execute<{ item_id: string; quantity: string }>(sql`
    select m.component_item_id as item_id, sum(m.required_qty-m.issued_qty)::text as quantity
      from mfg_wo_materials m join mfg_work_orders w
        on w.org_id=m.org_id and w.id=m.work_order_id
     where m.org_id=${orgId} and w.subsidiary_id=${subsidiaryId}
       and w.status in ('released','in_progress') and m.waived_at is null
       and m.required_qty > m.issued_qty
     group by m.component_item_id`)).rows;
  const itemCodeRows = (await tx.execute<ItemCode>(sql`
    select id, code, name from items where org_id=${orgId}`)).rows;
  const codes = new Map(itemCodeRows.map((row) => [row.id, itemLabel(row.code, row.name)]));
  const policyByItem = new Map<string, Policy>(policies.map((row) => [row.item_id, {
    itemId: row.item_id, itemCode: codes.get(row.item_id) ?? row.item_id,
    supplyMethod: row.supply_method, leadTimeDays: row.lead_time_days,
    safetyStockQty: row.safety_stock_qty, minimumQty: row.minimum_qty,
    orderMultipleQty: row.order_multiple_qty, updatedAt: row.updated_at,
  }]));
  for (const id of itemIds) if (!policyByItem.has(id)) policyByItem.set(id, {
    itemId: id, itemCode: codes.get(id) ?? id, supplyMethod: "buy", leadTimeDays: null,
    safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", updatedAt: "1970-01-01T00:00:00.000Z",
  });
  const ids = [...new Set([...itemIds, ...policies.map((row) => row.item_id), ...orderLines.map((row) => row.item_id), ...workOrders.map((row) => row.item_id), ...reservations.map((row) => row.item_id)])];
  const profiles = await stockedItems(tx as Runner, orgId, ids);
  const base = (itemId: string, quantity: string, unit: string | null, description: string) => {
    const profile = profiles.get(itemId);
    if (!profile) refuse(`${description} refers to an item without an inventory profile.`, "mrp_item_not_stocked", "add an inventory costing profile to the item");
    try { return toBaseQuantity(quantity, unit, profile.conversions, profile.baseUnit, description); }
    catch (error) { refuse(`${description}: ${error instanceof Error ? error.message : String(error)}`, "mrp_unit_not_convertible", "add a valid unit conversion to the item's inventory profile"); }
  };
  const demands: Demand[] = demandRows.map((row) => ({
    itemId: row.item_id, itemCode: itemLabel(row.item_code, row.item_name),
    quantity: base(row.item_id, row.quantity, row.unit, `Sales order ${row.document_number} line ${row.line_number}`),
    dueDate: row.due_date,
    demandRef: { type: "sales_order_line", documentId: row.document_id, documentNumber: row.document_number, lineId: row.line_id, lineNumber: row.line_number },
  }));
  const receipts: Receipt[] = [
    ...orderLines.map((row) => ({ itemId: row.item_id, quantity: base(row.item_id, row.quantity, row.unit, "Purchase order line"), dueDate: row.due_date, type: "purchase_order" })),
    ...workOrders.map((row) => ({ itemId: row.item_id, quantity: row.quantity, dueDate: row.due_date, type: "work_order" })),
  ];
  const reserved = new Map(reservations.map((row) => [row.item_id, row.quantity]));
  return { demands, receipts, policies: policyByItem, codes, profiles, reserved, itemIds: ids };
}

async function explodedComponentDemand(
  tx: SqlExecutor,
  orgId: string,
  parent: Demand,
  quantity: string,
  plannedStart: string,
): Promise<Demand[]> {
  await explodeBom(tx, orgId, parent.itemId, quantity, plannedStart);
  const rows = (await tx.execute<{
    item_id: string; item_code: string | null; item_name: string;
    quantity_per: string;quantity_basis:BomQuantityBasis;formula_output_quantity:string; scrap_pct: string | null; is_byproduct: boolean;
  }>(sql`
    select b.component_item_id as item_id, i.code as item_code, i.name as item_name,
           b.quantity_per::text,b.quantity_basis,b.formula_output_quantity::text, b.scrap_pct::text, b.is_byproduct
      from bom_components b join items i on i.org_id=b.org_id and i.id=b.component_item_id
     where b.org_id=${orgId} and b.assembly_item_id=${parent.itemId}
       and (b.effective_from is null or b.effective_from <= ${plannedStart}::date)
       and (b.effective_to is null or ${plannedStart}::date < b.effective_to)
       and not b.is_byproduct
     order by b.sort_order,b.component_item_id,b.operation_seq nulls first`)).rows;
  const path = Array.isArray(parent.demandRef.path)
    ? parent.demandRef.path.filter((part): part is string => typeof part === "string")
    : [parent.itemCode];
  const requiredByItem = new Map<string, { itemCode: string; quantity: string }>();
  for (const row of rows) {
    const entry = requiredByItem.get(row.item_id);
    const required = bomRequiredQuantity(quantity, row.quantity_per, row.scrap_pct,{quantityBasis:row.quantity_basis,formulaOutputQuantity:row.formula_output_quantity}).quantity;
    requiredByItem.set(row.item_id, {
      itemCode: itemLabel(row.item_code, row.item_name),
      quantity: add(entry?.quantity ?? "0", required),
    });
  }
  return [...requiredByItem].map(([itemId, entry]) => ({
    itemId,
    itemCode: entry.itemCode,
    quantity: entry.quantity,
    dueDate: plannedStart,
    demandRef: {
      type: "work_order_material",
      parentItemId: parent.itemId,
      parentItemCode: parent.itemCode,
      path: [...path, entry.itemCode],
    },
  }));
}

async function buildCapacity(
  tx: SqlExecutor, orgId: string, actorId: string, subsidiaryId: string,
  runDate: string, horizonEnd: string, planned: Planned[], scope: ReadonlySet<string> | null,
): Promise<{weeks:Array<{workCenterId:string;workCenterCode:string;calendarId:string;weekStart:string;plannedHours:string;availableHours:string}>;centers:Array<{workCenterId:string;calendarId:string;hoursPerDay:string;efficiencyPct:string;workingDays:unknown;holidays:unknown}>}> {
  await tx.execute(sql`select id from mfg_work_centers where org_id=${orgId} and subsidiary_id=${subsidiaryId} and is_active order by id for share`);
  await tx.execute(sql`select calendar.id from schedule_calendars calendar where calendar.org_id=${orgId} and (calendar.id in(select calendar_id from mfg_work_centers where org_id=${orgId} and subsidiary_id=${subsidiaryId} and is_active) or calendar.is_default and calendar.project_id is null) order by calendar.id for share`);
  await tx.execute(sql`select department.id from departments department where department.org_id=${orgId} and department.id in(select department_id from mfg_work_centers where org_id=${orgId} and subsidiary_id=${subsidiaryId} and is_active) order by department.id for share`);
  await tx.execute(sql`select project.id from projects project join schedule_calendars calendar on calendar.org_id=project.org_id and calendar.project_id=project.id where project.org_id=${orgId} and calendar.id in(select calendar_id from mfg_work_centers where org_id=${orgId} and subsidiary_id=${subsidiaryId} and is_active) order by project.id for share of project`);
  if((await tx.execute(sql`select center.id from mfg_work_centers center where center.org_id=${orgId} and center.subsidiary_id=${subsidiaryId} and center.is_active and not(true ${centerResourcesVisible(scope)}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  const centers = (await tx.execute<{
    id: string;code:string;calendar_id:string|null; capacity_hours_per_day: string; efficiency_pct: string;
    working_days: unknown; holidays: unknown;
  }>(sql`
    select c.id,c.code,cal.id as calendar_id, c.capacity_hours_per_day::text, c.efficiency_pct::text,
           cal.working_days, cal.holidays
      from mfg_work_centers c
      left join schedule_calendars cal on cal.org_id=c.org_id and
        (cal.id=c.calendar_id or (c.calendar_id is null and cal.is_default and cal.project_id is null))
     where c.org_id=${orgId} and c.subsidiary_id=${subsidiaryId} and c.is_active
     order by c.code, c.id`)).rows;
  if (centers.some((center) => center.working_days === null)) {
    refuse("A manufacturing work center has no schedule calendar.", "mrp_calendar_required", "open Company Setup → Work & Production → Work calendars, set a company default or assign a calendar to each work center");
  }
  if(new Set(centers.map(center=>center.id)).size!==centers.length) refuse("A work center resolves to more than one default calendar.","mrp_calendar_ambiguous","open Company Setup → Work & Production → Work calendars to choose one default, or assign an explicit company calendar to the work center");
  const plannedHours = new Map<string, string>();
  const addHours = (centerId: string, day: string, minutes: string) => {
    const week = monday(day); const key = `${centerId}:${week}`;
    plannedHours.set(key, add(plannedHours.get(key) ?? "0", div(minutes, "60")));
  };
  const actual = (await tx.execute<{
    work_center_id: string; week_date: string; setup: string; run: string;
  }>(sql`
    select op.work_center_id, coalesce(w.planned_start,w.planned_end,${runDate}::date)::text as week_date,
           op.planned_setup_minutes::text as setup, op.planned_run_minutes::text as run
      from mfg_wo_operations op join mfg_work_orders w
        on w.org_id=op.org_id and w.id=op.work_order_id
     where w.org_id=${orgId} and w.subsidiary_id=${subsidiaryId}
       and w.status in ('released','in_progress') and op.status <> 'done'`)).rows;
  for (const row of actual) addHours(row.work_center_id, row.week_date, add(row.setup, row.run));
  for (const order of planned.filter((entry) => entry.action === "make")) {
    const routing = (await tx.execute<{ id: string }>(sql`
      select id from mfg_routings where org_id=${orgId} and produced_item_id=${order.itemId}
        and status='active' and effective_from <= ${order.plannedStart}::date
        and (effective_to is null or ${order.plannedStart}::date < effective_to)
      order by version desc limit 1`)).rows[0];
    if (!routing) continue;
    const ops = (await tx.execute<{ work_center_id: string; setup_minutes: string; run_minutes_per_unit: string }>(sql`
      select work_center_id, setup_minutes::text, run_minutes_per_unit::text
        from mfg_routing_operations where org_id=${orgId} and routing_id=${routing.id} order by sequence`)).rows;
    for (const op of ops) addHours(op.work_center_id, order.plannedStart, add(op.setup_minutes, mul(op.run_minutes_per_unit, order.quantity)));
  }
  if([...plannedHours.keys()].some(key=>!centers.some(center=>key.startsWith(center.id+":")))) refuse("Planned work uses a center outside this entity’s active capacity plan.","mrp_capacity_center_unavailable","activate and assign the work center to this legal entity, or run MRP without capacity checking; dates will remain unchanged");
  const startWeek = monday(runDate); const lastWeek = monday(horizonEnd);
  const weeks: string[] = [];
  for (let week = startWeek; week <= lastWeek; week = addDays(week, 7)) weeks.push(week);
  const inserts: Array<{ centerId: string; week: string; planned: string; available: string }> = [];
  for (const center of centers) {
    const days = isRecord(center.working_days) ? center.working_days as Record<string, unknown> : {};
    const holidays = new Set(Array.isArray(center.holidays) ? center.holidays.map(String) : []);
    for (const week of weeks) {
      let workdays = 0;
      for (let offset = 0; offset < 7; offset++) {
        const date = addDays(week, offset);
        const weekday = String(new Date(`${date}T00:00:00.000Z`).getUTCDay());
        if (days[weekday] === true && !holidays.has(date)) workdays++;
      }
      const available = mulPercent(mul(center.capacity_hours_per_day, String(workdays)), center.efficiency_pct);
      inserts.push({ centerId: center.id, week, planned: plannedHours.get(`${center.id}:${week}`) ?? "0", available });
    }
  }
  await tx.execute(sql`delete from mfg_capacity_weeks w using mfg_work_centers c
    where w.org_id=${orgId} and c.org_id=w.org_id and c.id=w.work_center_id and c.subsidiary_id=${subsidiaryId}`);
  const snapshot:Array<{workCenterId:string;workCenterCode:string;calendarId:string;weekStart:string;plannedHours:string;availableHours:string}>=[];
  for (const row of inserts) {
    const saved = await tx.execute<{ id: string }>(sql`
      insert into mfg_capacity_weeks (org_id,work_center_id,week_start,planned_hours,available_hours,created_by,updated_by)
      values (${orgId},${row.centerId},${row.week},${row.planned},${row.available},${actorId},${actorId}) returning id`);
    if (saved.rows.length !== 1) refuse("Weekly capacity facts were not saved.", "mrp_capacity_write_failed", "retry the MRP run");
    const center=centers.find(center=>center.id===row.centerId)!;
    snapshot.push({workCenterId:row.centerId,workCenterCode:center.code,calendarId:center.calendar_id!,weekStart:row.week,plannedHours:row.planned,availableHours:row.available});
  }
  return {weeks:snapshot,centers:centers.map(center=>({workCenterId:center.id,calendarId:center.calendar_id!,hoursPerDay:center.capacity_hours_per_day,efficiencyPct:center.efficiency_pct,workingDays:center.working_days,holidays:center.holidays}))};
}

/** Freeze the run inputs, time-phase shortages, then write human-reviewable suggestions. */
export async function runMrp(
  tx: SqlExecutor, orgId: string, actorId: string, raw: RunMrpOptions,
  idempotency?: { id: string },
): Promise<MrpRun> {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const scope=await lockPlanningAuthority(tx,orgId,actorId,raw.subsidiaryId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mfg-mrp:${orgId}:${raw.subsidiaryId}`}, 0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mfg-mrp-number:${orgId}`}, 0))`);
  const horizonDays = raw.horizonDays ?? 90;
  const capacityCheck = raw.capacityCheck ?? true;
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) {
    refuse("The MRP horizon must be from 1 to 366 days.", "invalid_mrp_horizon", "choose a horizon from 1 to 366 days", 400);
  }
  const subsidiary = (await tx.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${orgId} and id=${raw.subsidiaryId} and is_active and not is_elimination for share`)).rows[0];
  if (!subsidiary) throw new ManufacturingNotFoundError();
  const runDate = await businessToday(orgId);
  const horizonEnd = addDays(runDate, horizonDays);
  const facts = await demandAndSupply(tx, orgId, raw.subsidiaryId, horizonEnd);
  const allItems = new Set([...facts.itemIds, ...facts.policies.keys(), ...facts.demands.map((d) => d.itemId), ...facts.receipts.map((r) => r.itemId)]);
  const atp = new Map<string, string>();
  for (const itemId of allItems) {
    const available = await getAvailableToPromise(tx as Runner, orgId, { subsidiaryId: raw.subsidiaryId, itemId });
    atp.set(itemId, available.onHand);
  }
  const receiptsByItem = new Map<string, Receipt[]>();
  for (const receipt of facts.receipts) receiptsByItem.set(receipt.itemId, [...(receiptsByItem.get(receipt.itemId) ?? []), receipt]);
  const runId = idempotency?.id ?? randomUUID();
  const nextNumber = (await tx.execute<{ sequence: string }>(sql`
    select (coalesce(max(substring(number from 5)::bigint)
      filter (where number ~ '^MRP-[0-9]+$'), 0) + 1)::text as sequence
      from mfg_mrp_runs where org_id=${orgId}`)).rows[0]?.sequence ?? "1";
  const runNumber = `MRP-${BigInt(nextNumber).toString().padStart(6, "0")}`;
  const policiesSnapshot = [...facts.policies.values()];
  const stockSnapshot = [...allItems].map((itemId) => ({ itemId, onHand: atp.get(itemId) ?? "0", reserved: facts.reserved.get(itemId) ?? "0", receipts: receiptsByItem.get(itemId) ?? [] }));
  const net = async (demands: Demand[]) => {
    const missing = new Set<string>();
    const planned: Planned[] = [];
    const projected = new Map<string, string>();
    const scheduled = new Map<string, Receipt[]>(receiptsByItem);
    const dependent: Demand[] = [];
    const ordered = [...demands].sort((a, b) => a.dueDate.localeCompare(b.dueDate)
      || a.itemCode.localeCompare(b.itemCode)
      || JSON.stringify(a.demandRef).localeCompare(JSON.stringify(b.demandRef)));
    for (const demand of ordered) {
      const policy = facts.policies.get(demand.itemId);
      if (!policy || policy.leadTimeDays === null) {
        missing.add(demand.itemCode);
        continue;
      }
      let position = projected.get(demand.itemId);
      if (position === undefined) position = add(atp.get(demand.itemId) ?? "0", neg(facts.reserved.get(demand.itemId) ?? "0"));
      const supply = scheduled.get(demand.itemId) ?? [];
      for (const receipt of supply.filter((entry) => entry.dueDate <= demand.dueDate)) position = add(position, receipt.quantity);
      scheduled.set(demand.itemId, supply.filter((entry) => entry.dueDate > demand.dueDate));
      position = add(position, neg(demand.quantity));
      if (cmp(position, "0") < 0) {
        const quantity = roundToMultiple(neg(position), policy.orderMultipleQty);
        const rawStart = addDays(demand.dueDate, -policy.leadTimeDays);
        const expedite = rawStart < runDate;
        const plannedStart = expedite ? runDate : rawStart;
        const suggestion: Planned = { ...demand, quantity, action: policy.supplyMethod, plannedStart, isExpedite: expedite };
        planned.push(suggestion);
        position = add(position, quantity);
        if (policy.supplyMethod === "make") {
          dependent.push(...await explodedComponentDemand(tx, orgId, demand, quantity, plannedStart));
        }
      }
      projected.set(demand.itemId, position);
    }
    for (const policy of facts.policies.values()) {
      const target = cmp(policy.minimumQty, policy.safetyStockQty) >= 0 ? policy.minimumQty : policy.safetyStockQty;
      if (cmp(target, "0") <= 0) continue;
      let position = projected.get(policy.itemId) ?? add(atp.get(policy.itemId) ?? "0", neg(facts.reserved.get(policy.itemId) ?? "0"));
      for (const receipt of scheduled.get(policy.itemId) ?? []) position = add(position, receipt.quantity);
      if (cmp(position, target) >= 0) continue;
      if (policy.leadTimeDays === null) {
        missing.add(policy.itemCode);
        continue;
      }
      const quantity = roundToMultiple(add(target, neg(position)), policy.orderMultipleQty);
      const rawStart = addDays(horizonEnd, -policy.leadTimeDays);
      const expedite = rawStart < runDate;
      const suggestion: Planned = {
        itemId: policy.itemId, itemCode: policy.itemCode, quantity, dueDate: horizonEnd,
        plannedStart: expedite ? runDate : rawStart, action: policy.supplyMethod, isExpedite: expedite,
        demandRef: cmp(policy.safetyStockQty, policy.minimumQty) >= 0
          ? { type: "safety_stock", itemId: policy.itemId }
          : { type: "minimum", itemId: policy.itemId },
      };
      planned.push(suggestion);
      if (policy.supplyMethod === "make") {
        dependent.push(...await explodedComponentDemand(tx, orgId, suggestion, quantity, suggestion.plannedStart));
      }
    }
    return { planned, dependent, missing };
  };
  let dependencies: Demand[] = [];
  let finalPlan: Awaited<ReturnType<typeof net>> | null = null;
  let stable = false;
  for (let pass = 0; pass < 34; pass++) {
    const result = await net([...facts.demands, ...dependencies]);
    if (result.missing.size) {
      const names = [...result.missing].sort().join(", ");
      refuse(`MRP cannot plan items without a lead time: ${names}.`, "mrp_lead_time_required", REMEDY_LEAD, 422);
    }
    const next = result.dependent;
    finalPlan = result;
    if (JSON.stringify(next) === JSON.stringify(dependencies)) {
      stable = true;
      dependencies = next;
      break;
    }
    dependencies = next;
  }
  if (!stable || !finalPlan) {
    refuse("MRP could not stabilize the nested material plan.", "mrp_plan_not_stable", "review the item's bills of material and manufacturing policies");
  }
  const planned = finalPlan.planned;
  const demandSnapshot = [...facts.demands, ...dependencies];
  const makeItemIds = [...new Set([...facts.policies.values()]
    .filter((policy) => policy.supplyMethod === "make")
    .map((policy) => policy.itemId))];
  const makeItemFilter = makeItemIds.length
    ? sql`and assembly_item_id in (${sql.join(makeItemIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql`and false`;
  const bomSnapshot = (await tx.execute(sql`
    select assembly_item_id as "assemblyItemId",component_item_id as "componentItemId",
           quantity_per::text as "quantityPer",quantity_basis as "quantityBasis",formula_output_quantity::text as "formulaOutputQuantity",scrap_pct::text as "scrapPct",is_byproduct as "isByproduct",
           effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",sort_order as "sortOrder",operation_seq as "operationSeq"
      from bom_components where org_id=${orgId} ${makeItemFilter}
        and (effective_from is null or effective_from <= ${horizonEnd}::date)
        and (effective_to is null or ${runDate}::date < effective_to)
     order by assembly_item_id,sort_order,component_item_id,operation_seq nulls first`)).rows;
  const routingItemFilter = makeItemIds.length
    ? sql`and r.produced_item_id in (${sql.join(makeItemIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql`and false`;
  const routingSnapshot = (await tx.execute(sql`
    select r.id as "routingId",r.produced_item_id as "producedItemId",r.code,r.version,
           r.effective_from::text as "effectiveFrom",r.effective_to::text as "effectiveTo",
           o.sequence,o.name,o.work_center_id as "workCenterId",o.setup_minutes::text as "setupMinutes",
           o.run_minutes_per_unit::text as "runMinutesPerUnit"
      from mfg_routings r left join mfg_routing_operations o on o.org_id=r.org_id and o.routing_id=r.id
     where r.org_id=${orgId} and r.status='active' ${routingItemFilter}
       and r.effective_from <= ${horizonEnd}::date and (r.effective_to is null or ${runDate}::date < r.effective_to)
     order by r.produced_item_id,r.version desc,o.sequence`)).rows;
  if((await tx.execute(sql`select r.id from mfg_routings r where r.org_id=${orgId} and r.status='active' ${routingItemFilter}
    and r.effective_from<=${horizonEnd}::date and (r.effective_to is null or ${runDate}::date<r.effective_to)
    and not(true ${routingResourcesVisible(scope)}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  if(capacityCheck&&(await tx.execute(sql`select center.id from mfg_work_centers center left join departments department on department.org_id=center.org_id and department.id=center.department_id
    where center.org_id=${orgId} and center.subsidiary_id=${raw.subsidiaryId} and center.is_active
      and not(true ${centerResourcesVisible(scope)}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  const parameters: Record<string, unknown> = {
    subsidiaryId: raw.subsidiaryId, horizonDays, demandSources: ["approved_sales_order_lines", "item_policy_replenishment", "make_order_bom_explosion"],
    demands: demandSnapshot.map(({ itemCode, itemId, dueDate, quantity, demandRef }) => ({ itemCode, itemId, dueDate, quantity, source: demandRef })),
    lotSizingRule: "round_up_to_order_multiple_after_safety_or_minimum_shortfall",
    leadTimeSource: "mfg_item_policies.lead_time_days", policies: policiesSnapshot,
    stockAndReceipts: stockSnapshot, activeBoms: bomSnapshot, activeRoutings: routingSnapshot, capacityCheck,
  };
  const created = await tx.execute<MrpRun>(sql`
    insert into mfg_mrp_runs (id,org_id,number,horizon_start,horizon_end,parameters,status,run_by,created_by,updated_by)
    values (${runId},${orgId},${runNumber},${runDate},${horizonEnd},${JSON.stringify(parameters)}::jsonb,'draft',${actorId},${actorId},${actorId})
    returning id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"`);
  const run = created.rows[0];
  if (!run) refuse("The MRP run was not saved.", "mrp_run_write_failed", "retry the run");
  await auditChange(tx, { orgId, actorId, table: "mfg_mrp_runs", rowId: run.id, action: "insert", before: null, after: run });
  for (const entry of planned) {
    const inserted = await tx.execute<MrpPlannedOrder>(sql`
      insert into mfg_planned_orders (org_id,run_id,item_id,quantity,due_date,action,demand_ref,status,is_expedite,planned_start,created_by,updated_by)
      values (${orgId},${run.id},${entry.itemId},${entry.quantity},${entry.dueDate},${entry.action},${JSON.stringify(entry.demandRef)}::jsonb,'suggested',${entry.isExpedite},${entry.plannedStart},${actorId},${actorId})
      returning id,run_id as "runId",item_id as "itemId",quantity::text,due_date::text as "dueDate",action,demand_ref as "demandRef",status,converted_ref_id as "convertedRefId",is_expedite as "isExpedite",planned_start::text as "plannedStart",dismiss_reason as "dismissReason"`);
    const row = inserted.rows[0];
    if (!row) refuse("An MRP suggestion was not saved.", "mrp_suggestion_write_failed", "retry the run");
    await auditChange(tx, { orgId, actorId, table: "mfg_planned_orders", rowId: row.id, action: "insert", before: null, after: row });
  }
  parameters.capacitySnapshot={format:"openbooks.manufacturing-capacity.v1",datesAdjusted:false,...(capacityCheck?await buildCapacity(tx,orgId,actorId,raw.subsidiaryId,runDate,horizonEnd,planned,scope):{weeks:[],centers:[]})};
  const completed = await tx.execute<MrpRun>(sql`
    update mfg_mrp_runs set status='complete',parameters=${JSON.stringify(parameters)}::jsonb,ran_at=now(),updated_at=now(),updated_by=${actorId}
     where org_id=${orgId} and id=${run.id} and status='draft'
    returning id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"`);
  const finalRun = completed.rows[0];
  if (!finalRun) refuse("The MRP run did not complete.", "mrp_run_complete_failed", "retry the run");
  await auditChange(tx, { orgId, actorId, table: "mfg_mrp_runs", rowId: finalRun.id, action: "update", before: run, after: finalRun });
  const old = await tx.execute<MrpRun>(sql`
    update mfg_mrp_runs set status='superseded',updated_at=now(),updated_by=${actorId}
     where org_id=${orgId} and status='complete' and id<>${run.id}
       and parameters->>'subsidiaryId'=${raw.subsidiaryId}
    returning id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"`);
  for (const before of old.rows) await auditChange(tx, { orgId, actorId, table: "mfg_mrp_runs", rowId: before.id, action: "update", before: { ...before, status: "complete" }, after: before });
  return finalRun;
}

export async function listMrpRuns(tx: SqlExecutor, orgId: string, subsidiaryId: string, limit = 20): Promise<MrpRun[]> {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  return (await tx.execute<MrpRun>(sql`
    select id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"
      from mfg_mrp_runs where org_id=${orgId} and parameters->>'subsidiaryId'=${subsidiaryId}
     order by ran_at desc nulls last,created_at desc limit ${Math.max(1, Math.min(limit, 100))}`)).rows;
}

export async function getMrpRun(tx: SqlExecutor, orgId: string, id: string,scope:ReadonlySet<string>|null=null) {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const run = (await tx.execute<MrpRun>(sql`
    select id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"
      from mfg_mrp_runs where org_id=${orgId} and id=${id}`)).rows[0];
  if (!run) throw new ManufacturingNotFoundError();
  const suggestions = (await tx.execute<MrpPlannedOrder & { code: string | null; item_name: string }>(sql`
    select p.id,p.run_id as "runId",p.item_id as "itemId",i.code,i.name as item_name,p.quantity::text,p.due_date::text as "dueDate",
           p.planned_start::text as "plannedStart",p.action,p.demand_ref as "demandRef",p.status,
           p.converted_ref_id as "convertedRefId",p.is_expedite as "isExpedite",p.dismiss_reason as "dismissReason"
      from mfg_planned_orders p join items i on i.org_id=p.org_id and i.id=p.item_id
     where p.org_id=${orgId} and p.run_id=${run.id} order by p.due_date,i.code,p.id`)).rows;
  const routes=run.parameters.activeRoutings;
  if(routes!==undefined&&!Array.isArray(routes))throw new ManufacturingNotFoundError();
  const routeIds=[...new Set(((routes as Array<{routingId:string}>|undefined)??[]).map(route=>route?.routingId))];
  if(routeIds.some(id=>!isUuid(id)))throw new ManufacturingNotFoundError();
  if(routeIds.length&&(await tx.execute(sql`select route.id from mfg_routings route where route.org_id=${orgId} and route.id in(${sql.join(routeIds.map(id=>sql`${id}::uuid`),sql`, `)}) ${routingResourcesVisible(scope,'route')}`)).rows.length!==routeIds.length)throw new ManufacturingNotFoundError();
  const sub = String(run.parameters.subsidiaryId ?? "");
  const snapshot=run.parameters.capacitySnapshot;
  if(snapshot!==undefined&&(!isRecord(snapshot)||snapshot.format!=="openbooks.manufacturing-capacity.v1"||snapshot.datesAdjusted!==false||!Array.isArray(snapshot.weeks))) refuse("The run has invalid retained capacity evidence.","mrp_capacity_evidence_invalid","review this run’s evidence with an administrator; rerun MRP for a new plan");
  const frozen=isRecord(snapshot)?snapshot.weeks as Array<{workCenterId:string;workCenterCode:string;calendarId:string;weekStart:string;plannedHours:string;availableHours:string}>:null;
  const centers=new Map<string,string>();
  if(frozen)for(const week of frozen) {
    if(!week||!isUuid(week.workCenterId)||!isUuid(week.calendarId)||typeof week.workCenterCode!=="string"||typeof week.weekStart!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(week.weekStart)||![week.plannedHours,week.availableHours].every(value=>typeof value==="string"&&/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/.test(value))) refuse("The run has invalid retained weekly capacity evidence.","mrp_capacity_evidence_invalid","review this run’s evidence with an administrator; rerun MRP for a new plan");
    const key=week.workCenterId+":"+week.calendarId;
    if(centers.has(key))continue;centers.set(key,week.workCenterId);
    if((await tx.execute(sql`select center.id from mfg_work_centers center left join departments department on department.org_id=center.org_id and department.id=center.department_id join schedule_calendars calendar on calendar.org_id=center.org_id and calendar.id=${week.calendarId} left join projects project on project.org_id=calendar.org_id and project.id=calendar.project_id
      where center.org_id=${orgId} and center.id=${week.workCenterId} ${centerResourcesVisible(scope)}
        and (calendar.project_id is null or project.id is not null and true ${subsidiaryVisibleFilter(sql`project.subsidiary_id`,scope)})`)).rows.length!==1)throw new ManufacturingNotFoundError();
  }
  const capacity = frozen?frozen.map(week=>({work_center_id:week.workCenterId,week_start:week.weekStart,planned_hours:week.plannedHours,available_hours:week.availableHours,code:week.workCenterCode})):(await tx.execute<{ work_center_id: string; week_start: string; planned_hours: string; available_hours: string; code: string }>(sql`
    select c.id as work_center_id,w.week_start::text,w.planned_hours::text,w.available_hours::text,c.code
      from mfg_capacity_weeks w join mfg_work_centers c on c.org_id=w.org_id and c.id=w.work_center_id
     where w.org_id=${orgId} and c.subsidiary_id=${sub} and w.week_start between ${monday(run.horizonStart)}::date and ${run.horizonEnd}::date
     order by w.week_start,c.code`)).rows;
  if(!frozen&&(await tx.execute(sql`select center.id from mfg_work_centers center left join departments department on department.org_id=center.org_id and department.id=center.department_id where center.org_id=${orgId} and center.subsidiary_id=${sub} and not(true ${centerResourcesVisible(scope)}) limit 1`)).rows.length)throw new ManufacturingNotFoundError();
  return {
    run,
    capacityEvidence:frozen?"frozen" as const:"legacy_current" as const,
    suggestions: suggestions.map(({ code, item_name, ...suggestion }) => ({ ...suggestion, itemCode: itemLabel(code, item_name) })),
    capacity: capacity.map((row) => {
      const planned = toUnits(row.planned_hours); const available = toUnits(row.available_hours);
      const percent = available === 0n ? null : fromUnits((planned * 1_000_000n + available / 2n) / available);
      return { workCenterId: row.work_center_id, workCenterCode: row.code, weekStart: row.week_start, plannedHours: row.planned_hours, availableHours: row.available_hours, loadPercent: percent, overloaded: planned > available };
    }),
  };
}

export async function findMrpRunRecord(tx: SqlExecutor, orgId: string, id: string, actorId?: string): Promise<MrpRun | null> {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const record=(await tx.execute<MrpRun>(sql`
    select id,number,horizon_start::text as "horizonStart",horizon_end::text as "horizonEnd",status,parameters,ran_at::text as "ranAt"
      from mfg_mrp_runs where org_id=${orgId} and id=${id}` )).rows[0] ?? null;
  if(record && actorId) await lockPlanningAuthority(tx,orgId,actorId,String(record.parameters.subsidiaryId??""));
  return record;
}

async function lockSuggestion(tx: SqlExecutor, orgId: string, id: string) {
  const row = (await tx.execute<{
    id: string; run_id: string; run_number: string; item_id: string; quantity: string; due_date: string; planned_start: string | null;
    action: "make" | "buy" | "transfer"; demand_ref: Record<string, unknown>; status: string;
    converted_ref_id: string | null; dismiss_reason: string | null; is_expedite: boolean;
    run_status: string; parameters: Record<string, unknown>;
    item_code: string | null; item_name: string; base_unit: string | null; policy_changed_after_run: boolean | null;
  }>(sql`
    select p.id,p.run_id,p.item_id,p.quantity::text,p.due_date::text,p.planned_start::text,p.action,p.demand_ref,p.status,
           p.converted_ref_id,p.dismiss_reason,p.is_expedite,r.number as run_number,r.status as run_status,r.parameters,
           i.code as item_code,i.name as item_name,profile.base_unit,
           (p0.updated_at > r.ran_at) as policy_changed_after_run
      from mfg_planned_orders p join mfg_mrp_runs r on r.org_id=p.org_id and r.id=p.run_id
      left join mfg_item_policies p0 on p0.org_id=p.org_id and p0.item_id=p.item_id
      left join item_inventory_profiles profile on profile.org_id=p.org_id and profile.item_id=p.item_id
      join items i on i.org_id=p.org_id and i.id=p.item_id
     where p.org_id=${orgId} and p.id=${id} for update of p`)).rows[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

async function lockAuthorizedSuggestion(tx:SqlExecutor,orgId:string,actorId:string,id:string,converting=false) {
  if(!isUuid(id)) throw new ManufacturingNotFoundError();
  const subject=(await tx.execute<{subsidiaryId:string;action:string}>(sql`select run.parameters->>'subsidiaryId' as "subsidiaryId",suggestion.action
    from mfg_planned_orders suggestion join mfg_mrp_runs run on run.org_id=suggestion.org_id and run.id=suggestion.run_id
    where suggestion.org_id=${orgId} and suggestion.id=${id}`)).rows[0];
  if(!subject) throw new ManufacturingNotFoundError();
  const scope=await lockPlanningAuthority(tx,orgId,actorId,subject.subsidiaryId,converting?(subject.action==='buy'?'ap.create':'items.post'):undefined);
  return {row:await lockSuggestion(tx,orgId,id),scope};
}

export async function getPlannedOrder(tx: SqlExecutor, orgId: string, id: string,actorId?:string) {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const row = actorId?(await lockAuthorizedSuggestion(tx,orgId,actorId,id,true)).row:await lockSuggestion(tx, orgId, id);
  return { ...row, subsidiaryId: String(row.parameters.subsidiaryId ?? "") };
}

export async function confirmPlannedOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const before = (await lockAuthorizedSuggestion(tx,orgId,actorId,id)).row;
  if (before.status === "confirmed") return before;
  if (before.status !== "suggested") refuse("Only a suggested planned order can be confirmed.", "planned_order_not_suggested", "select a suggested planned order", 409);
  const updated = await tx.execute(sql`update mfg_planned_orders set status='confirmed',updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${id} and status='suggested' returning id`);
  if (updated.rows.length !== 1) refuse("The planned order was not confirmed.", "planned_order_write_failed", "reload the planned order and retry");
  await auditChange(tx, { orgId, actorId, table: "mfg_planned_orders", rowId: id, action: "update", before, after: { ...before, status: "confirmed" } });
  return { ...before, status: "confirmed" };
}

export async function dismissPlannedOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string, reason: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const text = reason.trim();
  if (!text) refuse("A dismissal reason is required.", "dismiss_reason_required", "enter why this suggestion is not being pursued", 400);
  const before = (await lockAuthorizedSuggestion(tx,orgId,actorId,id)).row;
  if (before.status !== "suggested") refuse("Only a suggested planned order can be dismissed.", "planned_order_not_suggested", "select a suggested planned order", 409);
  const updated = await tx.execute(sql`update mfg_planned_orders set status='dismissed',dismiss_reason=${text},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${id} and status='suggested' returning id`);
  if (updated.rows.length !== 1) refuse("The planned order was not dismissed.", "planned_order_write_failed", "reload the planned order and retry");
  await auditChange(tx, { orgId, actorId, table: "mfg_planned_orders", rowId: id, action: "update", before, after: { ...before, status: "dismissed", dismiss_reason: text } });
  return { ...before, status: "dismissed", dismiss_reason: text };
}

function assertConvertible(row: Awaited<ReturnType<typeof lockSuggestion>>) {
  if (row.status === "converted" && row.converted_ref_id) return;
  if (row.status !== "confirmed") refuse("Confirm this planned order before converting it.", "planned_order_not_confirmed", "confirm the suggestion first", 409);
  if (row.run_status === "superseded") refuse("This MRP run was superseded; re-run MRP before converting its suggestions.", "mrp_run_superseded", "re-run MRP", 409);
  if (row.policy_changed_after_run) {
    refuse(`The manufacturing policy for ${itemLabel(row.item_code, row.item_name)} changed after this MRP run.`, "mrp_policy_changed", "re-run MRP to use the updated item policy", 409);
  }
}

async function markConverted(tx: SqlExecutor, orgId: string, actorId: string, row: Awaited<ReturnType<typeof lockSuggestion>>, targetId: string) {
  const updated = await tx.execute(sql`update mfg_planned_orders set status='converted',converted_ref_id=${targetId},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${row.id} and status='confirmed' returning id`);
  if (updated.rows.length !== 1) refuse("The planned order conversion was not recorded.", "planned_order_write_failed", "reload the suggestion before converting it");
  await auditChange(tx, { orgId, actorId, table: "mfg_planned_orders", rowId: row.id, action: "update", before: row, after: { ...row, status: "converted", converted_ref_id: targetId } });
}

export async function markBuyPlannedOrderConverted(
  tx: SqlExecutor, orgId: string, actorId: string, id: string, targetId: string,
): Promise<{ id: string; action: "buy"; replayed: boolean }> {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const row = (await lockAuthorizedSuggestion(tx,orgId,actorId,id,true)).row;
  if (row.action !== "buy") refuse("Only a purchase suggestion can be converted to a purchase order.", "mrp_buy_action_required", "select a buy suggestion", 409);
  if (row.status === "converted" && row.converted_ref_id) return { id: row.converted_ref_id, action: "buy", replayed: true };
  assertConvertible(row);
  const purchase=(await tx.execute(sql`select document.id from documents document
    where document.org_id=${orgId} and document.id=${targetId} and document.kind='purchase_order'
      and document.subsidiary_id::text=${String(row.parameters.subsidiaryId??'')}
      and exists(select 1 from document_lines line where line.org_id=document.org_id and line.document_id=document.id
        and line.item_id=${row.item_id} and line.quantity=${row.quantity}::numeric) for share of document`)).rows[0];
  if(!purchase) refuse('The purchase order does not match this saved suggestion.','mrp_purchase_source_mismatch','Create the purchase order from the saved MRP suggestion.',409);
  await markConverted(tx, orgId, actorId, row, targetId);
  return { id: targetId, action: "buy", replayed: false };
}

export async function convertPlannedOrder(
  tx: SqlExecutor, orgId: string, actorId: string, id: string,
  input: { fromLocationId?: string; toLocationId?: string },
): Promise<{ id: string; action: string; replayed: boolean }> {
  await assertManufacturingFeature(tx, orgId, "manufacturingMrp");
  const {row,scope} = await lockAuthorizedSuggestion(tx,orgId,actorId,id,true);
  if (row.action === "buy") refuse(
    "Convert this purchase suggestion through its purchase order route.",
    "mrp_buy_route_required",
    "convert the suggestion with a vendor from its planned order",
    409,
  );
  if (row.status === "converted" && row.converted_ref_id) return { id: row.converted_ref_id, action: row.action, replayed: true };
  assertConvertible(row);
  const subsidiaryId = String(row.parameters.subsidiaryId ?? "");
  let targetId: string;
  if (row.action === "make") {
    const routing = (await tx.execute<{ id: string }>(sql`select r.id from mfg_routings r where r.org_id=${orgId} and r.produced_item_id=${row.item_id}
      and r.status='active' and r.effective_from <= ${row.planned_start ?? row.due_date}::date
      and (r.effective_to is null or ${row.planned_start ?? row.due_date}::date < r.effective_to) ${routingResourcesVisible(scope)} order by r.version desc limit 1`)).rows[0];
    if (!routing) refuse(`Item ${itemLabel(row.item_code, row.item_name)} has no active routing for this planned start.`, "mrp_routing_required", "activate a routing for the item before converting this make suggestion", 409);
    const workOrder = await createWorkOrder(tx, orgId, actorId, {
      producedItemId: row.item_id, quantityOrdered: row.quantity, subsidiaryId,
      plannedStart: row.planned_start, plannedEnd: row.due_date, routingId: routing.id, source: "manual",
    });
    targetId = workOrder.id;
    const tagged = await tx.execute(sql`update mfg_work_orders set source='mrp',source_ref_id=${row.id},updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${targetId} and source='manual' and status='draft' returning id`);
    if (tagged.rows.length !== 1) refuse("The MRP work order source was not recorded.", "mrp_work_order_write_failed", "retry the conversion");
    await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: targetId, action: "update", before: { source: "manual", sourceRefId: null }, after: { source: "mrp", sourceRefId: row.id } });
  } else {
    if (!input.fromLocationId || !input.toLocationId) refuse("A transfer suggestion needs both locations.", "mrp_transfer_locations_required", "choose a from location and a to location", 400);
    const count = (await tx.execute<{ count: string }>(sql`select count(*)::text as count from stock_locations where org_id=${orgId} and is_active`)).rows[0];
    if (Number(count?.count ?? "0") < 2) refuse("A transfer suggestion needs at least two active stock locations.", "mrp_transfer_locations_required", "add another stock location before converting the suggestion", 409);
    if (input.fromLocationId === input.toLocationId) refuse("A transfer needs two different locations.", "mrp_transfer_same_location", "choose different from and to locations", 400);
    const transfer = await createTransferOrder(orgId, actorId, {
      fromStockLocationId: input.fromLocationId, toStockLocationId: input.toLocationId,
      subsidiaryId, orderedOn: await businessToday(orgId), memo: `MRP run ${row.run_number}: ${itemLabel(row.item_code, row.item_name)} due ${row.due_date}`,
      lines: [{ itemId: row.item_id, quantity: row.quantity }],
    });
    targetId = transfer.id;
  }
  await markConverted(tx, orgId, actorId, row, targetId);
  return { id: targetId, action: row.action, replayed: false };
}
