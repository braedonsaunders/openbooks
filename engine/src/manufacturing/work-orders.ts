import { sql } from "drizzle-orm";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { add, cmp, div, mul, normalizeMoney, toUnits, fromUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { formatInZone } from "../platform/business-date.ts";
import { now } from "../platform/clock.ts";
import { canonicalTimeZone } from "../platform/time-zone.ts";
import { loadSubsidiaryContext, SubsidiaryError, type SubsidiaryContext } from "../organization/subsidiaries.ts";
import {
  computeCostRate,
  convertFixedLaborComponents,
  convertLaborWage,
  laborCostingSettingsInTx,
  laborFxQuoteInTx,
  resolveStandardLaborRateInTx,
  type LaborCostingSettings,
  type LaborFxQuoteEvidence,
  type StandardLaborRate,
} from "../projects/labor-costing.ts";
import {
  resolveStandardOverheadCardsInTx,
  type StandardOverheadBasis,
  type StandardOverheadCard,
} from "../allocations/overhead-post.ts";
import type { OverheadExecutor } from "../allocations/overhead-sync.ts";
import { getAvailableToPromise } from "../inventory/availability.ts";
import { bomRequiredQuantity } from "../inventory/bom-scrap.ts";
import { resolveProfile, assertStockLocationAdmitsSubsidiary } from "../inventory/profile-policy.ts";
import { inventoryRequestHash } from "../inventory/action-idempotency.ts";
import type { Runner } from "../inventory/contracts.ts";
import { explodeBom } from "./bom-explode.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue, isoDate } from "./master-support.ts";
import { getManufacturingPolicies } from "./policies.ts";
import { backflushOperation } from "./materials.ts";

export interface WorkOrderInput {
  producedItemId: string;
  quantityOrdered: string;
  subsidiaryId: string;
  issueLocationId?: string | null;
  receiptLocationId?: string | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  routingId?: string | null;
  priority?: "low" | "normal" | "high" | "rush";
  source?: "manual" | "sales_order";
  sourceRefId?: string | null;
}

export interface WorkOrderPatch {
  quantityOrdered?: string;
  issueLocationId?: string | null;
  receiptLocationId?: string | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  routingId?: string | null;
}

const workOrderColumns = sql`id, org_id as "orgId", number, produced_item_id as "producedItemId",
  routing_id as "routingId", bom_revision as "bomRevision", routing_version as "routingVersion",
  quantity_ordered::text as "quantityOrdered", quantity_completed::text as "quantityCompleted",
  quantity_scrapped::text as "quantityScrapped", unit, status, priority, source,
  source_ref_id as "sourceRefId", parent_wo_id as "parentWoId", subsidiary_id as "subsidiaryId",
  issue_location_id as "issueLocationId", receipt_location_id as "receiptLocationId",
  planned_start::text as "plannedStart", planned_end::text as "plannedEnd",
  released_at as "releasedAt", started_at as "startedAt", completed_at as "completedAt",
  closed_at as "closedAt", hold_reason as "holdReason", cancel_reason as "cancelReason",
  hold_prior_status as "holdPriorStatus",
  standard_cost_snapshot::text as "standardCostSnapshot", cost_collected::text as "costCollected"`;

type WorkOrderRow = {
  id: string; orgId: string; number: string; producedItemId: string; routingId: string | null;
  bomRevision: string | null; routingVersion: number | null; quantityOrdered: string;
  quantityCompleted: string; quantityScrapped: string; unit: string; status: string;
  priority: string; source: string; sourceRefId: string | null; parentWoId: string | null;
  subsidiaryId: string | null; issueLocationId: string | null; receiptLocationId: string | null;
  plannedStart: string | null; plannedEnd: string | null; releasedAt: Date | null; startedAt: Date | null;
  completedAt: Date | null; closedAt: Date | null; holdReason: string | null; cancelReason: string | null;
  holdPriorStatus: string | null;
  standardCostSnapshot: string | null; costCollected: string;
};

type WorkOrderRead = WorkOrderRow & { pendingApproval: boolean };

function refuse(message: string, code: string, remedy: string, status = 422): never {
  throw new ManufacturingError(message, { status, code, remedy });
}

function rowOrNotFound<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

async function loadOrder(tx: SqlExecutor, orgId: string, id: string, lock = false): Promise<WorkOrderRow> {
  return rowOrNotFound((await tx.execute<WorkOrderRow>(sql`
    select ${workOrderColumns} from mfg_work_orders
     where org_id=${orgId} and id=${id} ${lock ? sql`for update` : sql``}`)).rows);
}

async function itemDetails(tx: SqlExecutor, orgId: string, itemId: string) {
  const row = (await tx.execute<{
    id: string; code: string | null; name: string; is_active: boolean;
    base_unit: string | null;
  }>(sql`
    select i.id, i.code, i.name, i.is_active, profile.base_unit
      from items i left join item_inventory_profiles profile
        on profile.org_id=i.org_id and profile.item_id=i.id
     where i.org_id=${orgId} and i.id=${itemId}`)).rows[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

async function validateLocation(
  tx: Runner,
  orgId: string,
  subsidiaryId: string,
  locationId: string | null,
  direction: "inbound" | "outbound",
): Promise<void> {
  if (!locationId) return;
  const context = await loadSubsidiaryContext(tx, orgId);
  await assertStockLocationAdmitsSubsidiary(tx, orgId, context, locationId, subsidiaryId, direction);
}

function checkQuantity(value: unknown): string {
  const quantity = decimalValue(value, "quantityOrdered", "Enter a positive exact quantity with no more than four decimal places.");
  if (compareDecimal(quantity, "0") <= 0) {
    refuse("Work order quantity must be greater than zero.", "invalid_quantity", "Enter a positive exact quantity with no more than four decimal places.");
  }
  return quantity;
}

async function validateSource(
  tx: SqlExecutor,
  orgId: string,
  source: "manual" | "sales_order" | "parent",
  sourceRefId: string | null,
  subsidiaryId: string,
): Promise<void> {
  if (source === "parent") {
    if (!sourceRefId) refuse("A child work order must reference its parent.", "invalid_parent_reference", "Release the parent work order to create its child orders.");
    return;
  }
  if (source === "manual") {
    if (sourceRefId !== null) refuse("A manual work order cannot reference a sales order.", "invalid_source_reference", "Choose manual source or link a sales order.");
    return;
  }
  if (!sourceRefId) refuse("A sales-order work order needs its source order.", "invalid_source_reference", "Choose the sales order this work order will fulfill.");
  const sourceRow = (await tx.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from documents where org_id=${orgId} and id=${sourceRefId} and kind='sales_order'`)).rows[0];
  if (!sourceRow || (sourceRow.subsidiary_id && sourceRow.subsidiary_id !== subsidiaryId)) {
    throw new ManufacturingNotFoundError();
  }
}

async function hasWorkOrderSubmitFlow(tx: SqlExecutor, orgId: string): Promise<boolean> {
  return (await tx.execute(sql`
    select 1 from flows flow_row
     where flow_row.org_id=${orgId} and flow_row.subject_kind='work_order' and flow_row.enabled
       and exists (
         select 1 from jsonb_array_elements(coalesce(flow_row.graph->'nodes', '[]'::jsonb)) node
          where node->'data'->>'kind'='trigger'
            and node->'data'->'trigger'->>'trigger'='on_submit'
       )
     limit 1`)).rows.length > 0;
}

async function hasPendingApproval(tx: SqlExecutor, orgId: string, id: string): Promise<boolean> {
  return (await tx.execute(sql`
    select 1 from flow_gates where org_id=${orgId} and subject_kind='work_order'
      and subject_id=${id} and status in ('pending','escalated') limit 1`)).rows.length > 0;
}

type PendingWorkOrderGate = { id: string; run_id: string; status: string };

async function lockPendingApprovals(tx: SqlExecutor, orgId: string, id: string): Promise<PendingWorkOrderGate[]> {
  return (await tx.execute<PendingWorkOrderGate>(sql`
    select id, run_id, status from flow_gates where org_id=${orgId} and subject_kind='work_order'
      and subject_id=${id} and status in ('pending','escalated') order by id for update`)).rows;
}

async function cancelPendingApprovals(tx: SqlExecutor, orgId: string, gates: PendingWorkOrderGate[], actorId: string, reason: string): Promise<void> {
  if (!gates.length) return;
  const runIds = [...new Set(gates.map((gate) => gate.run_id))];
  const gateIds = gates.map((gate) => gate.id);
  const cancelledGates = await tx.execute(sql`
    update flow_gates set status='cancelled', comment=${reason}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(gateIds)}::jsonb)::uuid)
       and status in ('pending','escalated') returning id`);
  if (cancelledGates.rows.length !== gateIds.length) {
    refuse("A pending work-order approval changed while the order was being cancelled.", "work_order_approval_changed", "Reload the work order and retry the cancellation.", 409);
  }
  for (const gate of gates) {
    await auditChange(tx, {
      orgId, actorId, table: "flow_gates", rowId: gate.id, action: "update",
      before: { status: gate.status }, after: { status: "cancelled", reason },
    });
  }
  const runStates = await tx.execute<{ id: string; status: string }>(sql`
    select id, status from flow_runs where org_id=${orgId}
      and id in (select jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb)::uuid)
      and status in ('running','waiting') order by id for update`);
  if (runStates.rows.length !== runIds.length) {
    refuse("A work-order approval run changed while the order was being cancelled.", "work_order_approval_changed", "Reload the work order and retry the cancellation.", 409);
  }
  const cancelledRuns = await tx.execute(sql`
    update flow_runs set status='cancelled', finished_at=now(), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb)::uuid)
       and status in ('running','waiting') returning id`);
  if (cancelledRuns.rows.length !== runIds.length) {
    refuse("A work-order approval run changed while the order was being cancelled.", "work_order_approval_changed", "Reload the work order and retry the cancellation.", 409);
  }
  for (const run of runStates.rows) {
    await auditChange(tx, {
      orgId, actorId, table: "flow_runs", rowId: run.id, action: "update",
      before: { status: run.status }, after: { status: "cancelled", reason },
    });
  }
}

async function insertDraft(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: Omit<WorkOrderInput, "source"> & { source: "manual" | "sales_order" | "parent"; sourceRefId: string | null },
  opts: { id?: string; requestId?: string; parentWoId?: string | null } = {},
): Promise<WorkOrderRead> {
  const item = await itemDetails(tx, orgId, input.producedItemId);
  if (!item.is_active) refuse(`Produced item ${item.code?.trim() || item.name} is inactive.`, "inactive_item", "Reactivate the item in Item setup before creating a work order.");
  const subsidiaries = await loadSubsidiaryContext(tx as Runner, orgId);
  const subsidiary = subsidiaries.byId.get(input.subsidiaryId);
  if (!subsidiary) throw new ManufacturingNotFoundError();
  if (!subsidiary.isActive || subsidiary.isElimination) {
    refuse("Choose an active operating subsidiary for the work order.", "invalid_work_order_subsidiary", "Choose an active, non-elimination subsidiary in Company setup.");
  }
  if (!item.base_unit) {
    refuse(`Produced item ${item.code?.trim() || item.name} has no inventory profile.`, "item_not_stocked", "Add an inventory costing profile in the item's Inventory costing section.");
  }
  const quantity = checkQuantity(input.quantityOrdered);
  const start = input.plannedStart == null ? null : isoDate(input.plannedStart, "plannedStart");
  const end = input.plannedEnd == null ? null : isoDate(input.plannedEnd, "plannedEnd");
  if (start && end && end < start) refuse("Planned end must be on or after planned start.", "invalid_work_order_dates", "Choose an end date on or after the start date.");
  if (input.priority && !["low", "normal", "high", "rush"].includes(input.priority)) {
    refuse("Choose a valid work-order priority.", "invalid_priority", "Choose low, normal, high, or rush.");
  }
  await validateSource(tx, orgId, input.source, input.sourceRefId, input.subsidiaryId);
  if (input.source === "parent" && opts.parentWoId !== input.sourceRefId) {
    refuse("A child work order must reference its parent work order.", "invalid_parent_reference", "Release the parent work order to create its child orders.");
  }
  await validateLocation(tx, orgId, input.subsidiaryId, input.issueLocationId ?? null, "outbound");
  await validateLocation(tx, orgId, input.subsidiaryId, input.receiptLocationId ?? null, "inbound");
  if (input.routingId) {
    const routing = (await tx.execute<{ id: string }>(sql`
      select id from mfg_routings where org_id=${orgId} and id=${input.routingId}
        and produced_item_id=${input.producedItemId}`)).rows[0];
    if (!routing) refuse("The selected routing is for a different produced item.", "routing_item_mismatch", "Choose a routing version for the produced item.");
  }
  const number = await allocateDocumentNumber(tx, orgId, "work_order", "WO-");
  const inserted = await tx.execute<WorkOrderRow>(sql`
    insert into mfg_work_orders (id, org_id, number, produced_item_id, routing_id, quantity_ordered, unit,
      status, priority, source, source_ref_id, parent_wo_id, subsidiary_id, issue_location_id,
      receipt_location_id, planned_start, planned_end, created_by, updated_by)
    values (coalesce(${opts.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${number}, ${input.producedItemId},
      ${input.routingId ?? null}, ${quantity}, ${item.base_unit}, 'draft', ${input.priority ?? "normal"}, ${input.source},
      ${input.sourceRefId}, ${opts.parentWoId ?? null}, ${input.subsidiaryId}, ${input.issueLocationId ?? null},
      ${input.receiptLocationId ?? null}, ${start}, ${end}, ${actorId}, ${actorId})
    returning ${workOrderColumns}`);
  const after = rowOrNotFound(inserted.rows);
  await auditChange(tx, {
    orgId, actorId, table: "mfg_work_orders", rowId: after.id, action: "insert", before: null,
    after: { status: "draft", reason: "Created as a draft work order.", order: after },
    requestId: opts.requestId,
  });
  return { ...after, pendingApproval: false };
}

export async function createWorkOrder(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: WorkOrderInput,
  idempotency?: { id: string; requestId: string },
): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const source = input.source ?? "manual";
  if (source !== "manual" && source !== "sales_order") {
    refuse("Only manual and sales-order work orders can be created directly.", "invalid_source", "Create child work orders through parent release, or choose manual/sales-order source.");
  }
  if (source === "manual" && input.sourceRefId) {
    refuse("A manual work order cannot reference a sales order.", "invalid_source_reference", "Choose manual source or link a sales order.");
  }
  return insertDraft(tx, orgId, actorId, {
    ...input,
    source,
    sourceRefId: source === "manual" ? null : input.sourceRefId ?? null,
  }, { id: idempotency?.id, requestId: idempotency?.requestId });
}

export async function getWorkOrder(tx: SqlExecutor, orgId: string, id: string, lock = false): Promise<WorkOrderRead | null> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  if (lock) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:mfg-work-order:${id}`}, 0))`);
  }
  const row = (await tx.execute<WorkOrderRow & { pendingApproval: boolean }>(sql`
    select ${workOrderColumns},
      (mfg_work_orders.status='draft' and exists (
        select 1 from flow_gates gate where gate.org_id=mfg_work_orders.org_id
          and gate.subject_kind='work_order' and gate.subject_id=mfg_work_orders.id
          and gate.status in ('pending','escalated')
      )) as "pendingApproval"
      from mfg_work_orders where org_id=${orgId} and id=${id} ${lock ? sql`for update` : sql``}`)).rows[0];
  return row ?? null;
}

export async function updateDraftWorkOrder(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  patch: WorkOrderPatch,
): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const before = await loadOrder(tx, orgId, id, true);
  if (before.status !== "draft") {
    await heldRefusal(before);
    refuse(`Work order ${before.number} is ${before.status} and cannot be edited.`, "work_order_not_draft", "Cancel the work order and create a replacement with the revised details.", 409);
  }
  if (await hasPendingApproval(tx, orgId, id)) {
    refuse(`Work order ${before.number} is awaiting approval and cannot be edited.`, "work_order_pending_approval", "Resolve or reject the pending approval before editing the draft.", 409);
  }
  const quantity = patch.quantityOrdered === undefined ? before.quantityOrdered : checkQuantity(patch.quantityOrdered);
  const start = patch.plannedStart === undefined ? before.plannedStart : patch.plannedStart === null ? null : isoDate(patch.plannedStart, "plannedStart");
  const end = patch.plannedEnd === undefined ? before.plannedEnd : patch.plannedEnd === null ? null : isoDate(patch.plannedEnd, "plannedEnd");
  if (start && end && end < start) refuse("Planned end must be on or after planned start.", "invalid_work_order_dates", "Choose an end date on or after the start date.");
  const issueLocationId = patch.issueLocationId === undefined ? before.issueLocationId : patch.issueLocationId;
  const receiptLocationId = patch.receiptLocationId === undefined ? before.receiptLocationId : patch.receiptLocationId;
  if (!before.subsidiaryId) refuse(`Work order ${before.number} has no subsidiary.`, "work_order_subsidiary_required", "Choose an operating subsidiary before editing the work order.");
  await validateLocation(tx as Runner, orgId, before.subsidiaryId, issueLocationId ?? null, "outbound");
  await validateLocation(tx as Runner, orgId, before.subsidiaryId, receiptLocationId ?? null, "inbound");
  const routingId = patch.routingId === undefined ? before.routingId : patch.routingId;
  if (routingId) {
    const routing = (await tx.execute(sql`select 1 from mfg_routings where org_id=${orgId} and id=${routingId} and produced_item_id=${before.producedItemId}`)).rows;
    if (!routing.length) refuse("The selected routing is for a different produced item.", "routing_item_mismatch", "Choose a routing version for the produced item.");
  }
  const updated = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set quantity_ordered=${quantity}, planned_start=${start}, planned_end=${end},
      issue_location_id=${issueLocationId ?? null}, receipt_location_id=${receiptLocationId ?? null},
      routing_id=${routingId ?? null}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status='draft' returning ${workOrderColumns}`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update", before, after });
  return { ...after, pendingApproval: false };
}

type ActiveRouting = {
  id: string; version: number; effective_from: string; effective_to: string | null;
  default_issue_location_id: string | null; default_receipt_location_id: string | null;
  overheadBasis: string;
};

async function activeRouting(
  tx: SqlExecutor,
  orgId: string,
  itemId: string,
  code: string,
  asOf: string,
  selectedId: string | null,
): Promise<ActiveRouting> {
  const matches = await tx.execute<ActiveRouting>(sql`
    select id, version, effective_from::text, effective_to::text,
           default_issue_location_id, default_receipt_location_id,
           overhead_basis as "overheadBasis"
      from mfg_routings
     where org_id=${orgId} and produced_item_id=${itemId} and status='active'
       and effective_from <= ${asOf}::date and (effective_to is null or ${asOf}::date < effective_to)
       and (${selectedId}::uuid is null or id=${selectedId})
     order by version desc for share`);
  if (matches.rows.length !== 1) {
    refuse(`No active routing version for ${code} is effective on ${asOf}.`, "routing_not_effective", `Activate a routing version for ${code}.`);
  }
  return matches.rows[0]!;
}

type BomRow = {
  component_item_id: string; component_code: string | null; quantity_per: string;
  sort_order: number; effective_from: string | null; effective_to: string | null;
  operation_seq: number | null; scrap_pct: string | null; is_byproduct: boolean;
};

async function effectiveBomRows(tx: SqlExecutor, orgId: string, itemId: string, asOf: string): Promise<BomRow[]> {
  return (await tx.execute<BomRow>(sql`
    select b.component_item_id, component.code as component_code, b.quantity_per::text as quantity_per,
           b.sort_order, b.effective_from::text as effective_from, b.effective_to::text as effective_to,
           b.operation_seq, b.scrap_pct::text as scrap_pct, b.is_byproduct
      from bom_components b join items component on component.org_id=b.org_id and component.id=b.component_item_id
     where b.org_id=${orgId} and b.assembly_item_id=${itemId}
       and (b.effective_from is null or b.effective_from <= ${asOf}::date)
       and (b.effective_to is null or ${asOf}::date < b.effective_to)
     order by b.sort_order, b.component_item_id, b.operation_seq nulls first,
              b.is_byproduct, b.effective_from nulls first`)).rows;
}

function bomRevision(itemId: string, rows: BomRow[]): string {
  const snapshot = {
    format: "openbooks.inventory-bom.v1" as const,
    assemblyItemId: itemId,
    components: rows.map((row) => {
      const evidence: {
        componentItemId: string; quantityPer: string; sortOrder: number;
        effectiveFrom?: string; effectiveTo?: string; operationSeq?: number; scrapPct?: string;
      } = {
        componentItemId: row.component_item_id,
        quantityPer: normalizeMoney(row.quantity_per),
        sortOrder: row.sort_order,
      };
      if (row.effective_from !== null) evidence.effectiveFrom = row.effective_from;
      if (row.effective_to !== null) evidence.effectiveTo = row.effective_to;
      if (row.operation_seq !== null) evidence.operationSeq = row.operation_seq;
      if (row.scrap_pct !== null && cmp(row.scrap_pct, "0") !== 0) evidence.scrapPct = normalizeMoney(row.scrap_pct);
      return evidence;
    }),
  };
  return `sha256:${inventoryRequestHash(snapshot)}`;
}

async function materialReservations(tx: SqlExecutor, orgId: string, subsidiaryId: string, itemId: string): Promise<string> {
  const row = (await tx.execute<{ reserved: string }>(sql`
    select coalesce(sum(greatest(material.required_qty-material.issued_qty-material.backflush_qty, 0)),0)::text as reserved
      from mfg_wo_materials material join mfg_work_orders order_row
        on order_row.org_id=material.org_id and order_row.id=material.work_order_id
     where material.org_id=${orgId} and material.component_item_id=${itemId}
       and order_row.subsidiary_id=${subsidiaryId} and order_row.status in ('released','in_progress')`)).rows[0];
  return row?.reserved ?? "0";
}

async function releaseMaterials(
  tx: SqlExecutor,
  orgId: string,
  order: WorkOrderRow,
  lines: Array<{ itemId: string; itemCode: string; required: string; operationSeq: number | null; quantityPer: string; scrapPct: string | null }>,
  issueLocationId: string,
): Promise<Array<{ itemId: string; itemCode: string; required: string; shortage: string; operationSeq: number | null; tracking: string; quantityPer: string; scrapPct: string | null }>> {
  const warehouse = (await tx.execute<{ warehouse_id: string | null }>(sql`
    select stock_location_warehouse(${orgId}::uuid, ${issueLocationId}::uuid) as warehouse_id`)).rows[0]?.warehouse_id ?? null;
  const itemIds = [...new Set(lines.map((line) => line.itemId))].sort();
  for (const itemId of itemIds) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:mfg-release:${order.subsidiaryId}:${itemId}`}, 0))`);
  }
  const shortages: string[] = [];
  const result: Array<{ itemId: string; itemCode: string; required: string; shortage: string; operationSeq: number | null; tracking: string; quantityPer: string; scrapPct: string | null }> = [];
  for (const itemId of itemIds) {
    const item = await itemDetails(tx, orgId, itemId);
    const displayCode = item.code?.trim() || item.name;
    const itemLines = lines.filter((line) => line.itemId === itemId)
      .map((material) => ({ ...material, itemCode: displayCode }));
    const line = itemLines[0]!;
    // ATP is the authoritative no-profile refusal; let it pass through unchanged.
    const atp = await getAvailableToPromise(tx as Runner, orgId, {
      itemId, subsidiaryId: order.subsidiaryId!, warehouseId: warehouse,
    });
    const profile = await resolveProfile(orgId, itemId, tx as Runner, true);
    const account = (await tx.execute<{ id: string }>(sql`
      select id from accounts where org_id=${orgId} and id=${profile.assetAccountId}
        and is_active and type like 'asset_%'`)).rows[0];
    if (!account) {
      refuse(`Component ${line.itemCode} has no active inventory asset account.`, "component_asset_account_missing", `Map accounts for ${line.itemCode} in item setup.`);
    }
    let remainingUnits = toUnits(atp.available) - toUnits(await materialReservations(tx, orgId, order.subsidiaryId!, itemId));
    for (const material of itemLines) {
      const availableUnits = remainingUnits > 0n ? remainingUnits : 0n;
      const requiredUnits = toUnits(material.required);
      const shortageUnits = requiredUnits - availableUnits;
      const shortage = fromUnits(shortageUnits > 0n ? shortageUnits : 0n);
      remainingUnits = availableUnits > requiredUnits ? availableUnits - requiredUnits : 0n;
      if (cmp(shortage, "0") > 0) shortages.push(`${material.itemCode}: ${shortage}`);
      result.push({ ...material, shortage, tracking: profile.tracking });
    }
  }
  const policy = await getManufacturingPolicies(tx, orgId);
  if (policy.shortagePolicy === "refuse" && shortages.length) {
    refuse(`Work order ${order.number} has material shortages: ${shortages.join(", ")}.`, "work_order_shortage", "Receive or transfer each named component into the order's issue warehouse before release.");
  }
  return result;
}

type CanonicalBurdenComponent = {
  key: string; kind: string; name: string; value: string; scaleWithOvertime: boolean;
};

type ReleaseBurdenDocument = {
  hoursPerDay: number;
  annualHours: number;
  components: CanonicalBurdenComponent[];
  source: {
    wageRowId: string; effectiveFrom: string; rate: string;
    currency: string; basis: string; annualHours: string;
  };
};

type ReleaseOverheadCardEvidence = {
  id: string; effectiveFrom: string; effectiveTo: string | null;
  kind: string; category: string | null; rate: string; method: string;
};

type ReleaseOverheadDocument = {
  format: "openbooks.manufacturing-overhead-snapshot.v1";
  basis: StandardOverheadBasis;
  departmentId: string | null;
  releaseDate: string;
  cards: ReleaseOverheadCardEvidence[];
};

type OperationReleaseSnapshot = {
  sequence: number;
  workCenterId: string;
  wageId: string;
  wageEffectiveFrom: string;
  wageRate: string;
  wageCurrency: string;
  wageBasis: string;
  wageAnnualHours: string;
  finalRate: string;
  functionalCurrency: string;
  burden: ReleaseBurdenDocument;
  burdenHash: string;
  fxClass: "par" | "quoted";
  fxRate: string;
  fxRowId: string | null;
  fxDate: string | null;
  fxSource: string | null;
  fxDirection: "direct" | "inverse" | null;
  overhead: ReleaseOverheadDocument;
  overheadHash: string;
  overheadCardIds: string[];
};

function kernelMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

function checkCurrencyCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z]{3}$/.test(code)) {
    return "";
  }
  return code;
}

// The organization's business release date, read through the release
// transaction itself: the calendar day in the org's configured time zone,
// never the UTC day and never an ambient read outside the release unit.
// Uses the same zone key, validator, and formatter as the shared business
// clock; an unknown stored zone refuses so the operator fixes the setting
// instead of releasing on the wrong day.
async function releaseBusinessDate(tx: SqlExecutor, orgId: string): Promise<string> {
  const row = (await tx.execute<{ time_zone: string | null }>(sql`
    select settings->>'timeZone' as time_zone from orgs where id=${orgId}`)).rows[0];
  if (!row) {
    refuse("The work order cannot be released because its organization is missing.", "org_not_found", "Contact an administrator; the organization record is missing.");
  }
  const stored = row.time_zone;
  if (!stored || !stored.trim()) return formatInZone(now(), "UTC");
  const canonical = canonicalTimeZone(stored);
  if (!canonical) {
    refuse(`Stored business time zone ${JSON.stringify(stored)} is not a known IANA time zone.`, "invalid_business_timezone", "Set Business time zone in Company Settings → Organization.");
  }
  return formatInZone(now(), canonical);
}

// The authoritative work-order legal entity and its functional currency,
// re-read inside the release transaction. A subsidiary that left the
// hierarchy, was deactivated, or lost its currency since creation refuses;
// there is no fallback to an org default.
async function releaseFunctionalCurrency(tx: SqlExecutor, orgId: string, order: WorkOrderRow): Promise<string> {
  let context: SubsidiaryContext;
  try {
    context = await loadSubsidiaryContext(tx as Runner, orgId);
  } catch (err) {
    if (err instanceof SubsidiaryError) {
      refuse(`Work order ${order.number} cannot be released because its subsidiary hierarchy is unavailable.`, "work_order_subsidiary_unavailable", "Restore the subsidiary hierarchy in Company Settings → Organization before releasing the work order.");
    }
    throw err;
  }
  const subsidiary = context.byId.get(order.subsidiaryId!);
  if (!subsidiary) {
    refuse(`Work order ${order.number} names a subsidiary outside this organization.`, "invalid_work_order_subsidiary", "Choose an active, non-elimination subsidiary in Company setup.");
  }
  if (!subsidiary.isActive || subsidiary.isElimination) {
    refuse("Choose an active operating subsidiary for the work order.", "invalid_work_order_subsidiary", "Choose an active, non-elimination subsidiary in Company setup.");
  }
  const currency = checkCurrencyCode(subsidiary.baseCurrency);
  if (!currency) {
    refuse(`Subsidiary ${subsidiary.name} has no usable functional currency.`, "subsidiary_currency_missing", "Set the subsidiary's base currency in Company Settings → Organization before releasing the work order.");
  }
  return currency;
}

function compareBurdenComponents(
  left: Pick<CanonicalBurdenComponent, "kind" | "key" | "name">,
  right: Pick<CanonicalBurdenComponent, "kind" | "key" | "name">,
): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return 0;
}

type ReleaseSnapshotCaches = {
  rates: Map<string, StandardLaborRate | null>;
  fx: Map<string, LaborFxQuoteEvidence | null>;
  overhead: Map<string, StandardOverheadCard[]>;
};

async function resolveOperationLabor(
  tx: SqlExecutor,
  orgId: string,
  order: WorkOrderRow,
  opLabel: string,
  departmentId: string,
  releaseDate: string,
  functionalCurrency: string,
  settings: LaborCostingSettings,
  caches: ReleaseSnapshotCaches,
): Promise<Pick<OperationReleaseSnapshot,
  "wageId" | "wageEffectiveFrom" | "wageRate" | "wageCurrency" | "wageBasis" | "wageAnnualHours" |
  "finalRate" | "functionalCurrency" | "burden" | "burdenHash" |
  "fxClass" | "fxRate" | "fxRowId" | "fxDate" | "fxSource" | "fxDirection">> {
  const laborRemedy = "Review labor costing rates and settings in Company Settings → Labor costing.";
  let rate = caches.rates.get(departmentId);
  if (rate === undefined) {
    try {
      rate = await resolveStandardLaborRateInTx(tx, orgId, {
        departmentId, subsidiaryId: order.subsidiaryId, releaseDate,
      });
    } catch (err) {
      refuse(kernelMessage(err, `The standard labor rate for ${opLabel} cannot be resolved.`), "standard_labor_rate_unresolved", laborRemedy);
    }
    caches.rates.set(departmentId, rate);
  }
  if (!rate) {
    refuse(`No standard labor rate covers ${opLabel} on ${releaseDate}.`, "standard_labor_rate_missing", `Add a department, subsidiary, or org-wide standard labor rate effective on or before ${releaseDate} in Company Settings → Labor costing.`);
  }
  const wageCurrency = checkCurrencyCode(rate.currency);
  if (!wageCurrency) {
    refuse(`Standard labor rate ${rate.rateId} carries an unusable currency.`, "standard_labor_currency_invalid", "Fix the rate's currency in Company Settings → Labor costing.");
  }
  // Annual source rates stay annual in the frozen evidence; the hourly wage
  // divides once by the row's own annual-hours evidence.
  const hourlyWage = rate.basis === "year" ? div(rate.rate, rate.annualHours) : rate.rate;
  const fxKey = `${wageCurrency}|${functionalCurrency}`;
  let quote = caches.fx.get(fxKey);
  if (quote === undefined) {
    quote = null;
    if (wageCurrency !== functionalCurrency) {
      try {
        quote = await laborFxQuoteInTx(tx, orgId, wageCurrency, functionalCurrency, releaseDate);
      } catch (err) {
        refuse(kernelMessage(err, `The FX conversion for ${opLabel} cannot be resolved.`), "standard_labor_fx_unresolved", "Review FX spot rates in Company Settings → FX provider.");
      }
    }
    caches.fx.set(fxKey, quote);
  }
  if (wageCurrency !== functionalCurrency && !quote) {
    refuse(`No FX spot rate converts standard labor ${wageCurrency} to ${functionalCurrency} on or before ${releaseDate} for ${opLabel}.`, "standard_labor_fx_missing", `Add an FX spot rate for ${wageCurrency} to ${functionalCurrency} covering ${releaseDate} in Company Settings → FX provider.`);
  }
  // One frozen conversion factor prices both the wage and the fixed burden
  // components; same-currency operations convert at an explicit par of 1.
  // No employee, trade, or actual-time context enters the standard: burden
  // components priced by worker-comp use their configured fallback value.
  const fxRate = quote ? quote.rate : "1";
  const functionalWage = convertLaborWage(hourlyWage, fxRate);
  const functionalComponents = convertFixedLaborComponents(settings.components, fxRate);
  let finalRate: string;
  try {
    finalRate = computeCostRate(functionalWage, "1", {
      hoursPerDay: settings.hoursPerDay, components: functionalComponents,
    });
  } catch (err) {
    refuse(kernelMessage(err, `The standard labor burden for ${opLabel} cannot be priced.`), "standard_labor_burden_invalid", laborRemedy);
  }
  const burden: ReleaseBurdenDocument = {
    hoursPerDay: settings.hoursPerDay,
    annualHours: settings.annualHours,
    components: [...settings.components]
      .map((component) => ({
        key: component.key,
        kind: component.kind,
        name: component.name,
        value: String(component.value),
        scaleWithOvertime: component.scaleWithOvertime === true,
      }))
      .sort(compareBurdenComponents),
    source: {
      wageRowId: rate.rateId,
      effectiveFrom: rate.effectiveFrom,
      rate: rate.rate,
      currency: rate.currency,
      basis: rate.basis,
      annualHours: rate.annualHours,
    },
  };
  return {
    wageId: rate.rateId,
    wageEffectiveFrom: rate.effectiveFrom,
    wageRate: rate.rate,
    wageCurrency: rate.currency,
    wageBasis: rate.basis,
    wageAnnualHours: rate.annualHours,
    finalRate,
    functionalCurrency,
    burden,
    burdenHash: `sha256:${inventoryRequestHash(burden)}`,
    fxClass: quote ? "quoted" : "par",
    fxRate,
    fxRowId: quote ? quote.id : null,
    fxDate: quote ? quote.asOf : null,
    fxSource: quote ? quote.source : null,
    fxDirection: quote ? (quote.inverse ? "inverse" : "direct") : null,
  };
}

async function resolveOperationOverhead(
  tx: SqlExecutor,
  orgId: string,
  opLabel: string,
  departmentId: string,
  basis: StandardOverheadBasis,
  releaseDate: string,
  caches: ReleaseSnapshotCaches,
): Promise<Pick<OperationReleaseSnapshot, "overhead" | "overheadHash" | "overheadCardIds">> {
  const overheadRemedy = "Review standard overhead rates in Company Settings → Overhead.";
  let cards = caches.overhead.get(departmentId);
  if (cards === undefined) {
    try {
      cards = await resolveStandardOverheadCardsInTx(tx as OverheadExecutor, orgId, {
        departmentId, basis, onDate: releaseDate,
      });
    } catch (err) {
      refuse(kernelMessage(err, `The standard overhead cards for ${opLabel} cannot be resolved.`), "standard_overhead_unresolved", overheadRemedy);
    }
    caches.overhead.set(departmentId, cards);
  }
  // The shared kernel returns only method='standard' cards of the mapped
  // kind, so percent, live, and average cards can never enter the frozen
  // set. An empty set is the kernel's defined uncovered outcome (inert):
  // it freezes as a canonical empty snapshot, never as another kind's
  // card and never as a live re-read at application time.
  const evidence: ReleaseOverheadCardEvidence[] = [];
  for (const card of cards) {
    let canonicalRate: string;
    try {
      canonicalRate = normalizeMoney(card.ratePercent);
    } catch {
      refuse(`Frozen standard overhead card ${card.id} carries an unusable rate.`, "standard_overhead_card_invalid", overheadRemedy);
    }
    evidence.push({
      id: card.id,
      effectiveFrom: card.effectiveFrom,
      effectiveTo: card.effectiveTo,
      kind: card.rateKind,
      category: card.category,
      rate: canonicalRate,
      method: card.method,
    });
  }
  const overhead: ReleaseOverheadDocument = {
    format: "openbooks.manufacturing-overhead-snapshot.v1",
    basis,
    departmentId,
    releaseDate,
    cards: evidence,
  };
  return {
    overhead,
    overheadHash: `sha256:${inventoryRequestHash(overhead)}`,
    overheadCardIds: evidence.map((card) => card.id),
  };
}

// Freeze every operation's complete labor/FX/overhead snapshot before the
// release status mutation. Any refusal throws before the status write, so
// the whole release transaction rolls back and no operation is ever
// inserted with a partial group.
async function resolveOperationReleaseSnapshots(
  tx: SqlExecutor,
  orgId: string,
  order: WorkOrderRow,
  operations: Array<{ sequence: number; work_center_id: string }>,
  routing: ActiveRouting,
  releaseDate: string,
  functionalCurrency: string,
): Promise<OperationReleaseSnapshot[]> {
  const laborRemedy = "Review labor costing rates and settings in Company Settings → Labor costing.";
  if (!["labor_hours", "machine_hours", "units"].includes(routing.overheadBasis)) {
    refuse(`Routing version ${routing.version} carries an unknown overhead basis.`, "invalid_overhead_basis", "Choose labor hours, machine hours, or units on the routing.");
  }
  const basis = routing.overheadBasis as StandardOverheadBasis;
  let settings: LaborCostingSettings;
  try {
    settings = await laborCostingSettingsInTx(tx, orgId);
  } catch (err) {
    refuse(kernelMessage(err, `The labor costing settings for work order ${order.number} cannot be resolved.`), "labor_costing_settings_invalid", laborRemedy);
  }
  const centerIds = [...new Set(operations.map((operation) => operation.work_center_id))].sort();
  const centers = (await tx.execute<{ id: string; code: string | null; department_id: string | null }>(sql`
    select id, code, department_id from mfg_work_centers
     where org_id=${orgId}
       and id in (select jsonb_array_elements_text(${JSON.stringify(centerIds)}::jsonb)::uuid)`)).rows;
  const centerById = new Map(centers.map((center) => [center.id, center]));
  const caches: ReleaseSnapshotCaches = { rates: new Map(), fx: new Map(), overhead: new Map() };
  const snapshots: OperationReleaseSnapshot[] = [];
  for (const operation of operations) {
    const opLabel = `operation ${operation.sequence} of work order ${order.number}`;
    const center = centerById.get(operation.work_center_id);
    if (!center) {
      refuse(`Work center ${operation.work_center_id} for ${opLabel} is outside this organization.`, "work_center_not_found", `Point ${opLabel} at a work center from this organization.`);
    }
    if (!center.department_id) {
      const code = center.code?.trim() || center.id;
      refuse(`Work center ${code} for ${opLabel} has no department.`, "work_center_department_required", `Choose an active department in Company Settings → Departments, then assign it to work center ${code}.`);
    }
    const departmentId = center.department_id;
    const labor = await resolveOperationLabor(tx, orgId, order, opLabel, departmentId, releaseDate, functionalCurrency, settings, caches);
    const overhead = await resolveOperationOverhead(tx, orgId, opLabel, departmentId, basis, releaseDate, caches);
    snapshots.push({
      sequence: operation.sequence,
      workCenterId: operation.work_center_id,
      ...labor,
      ...overhead,
    });
  }
  return snapshots;
}

async function releaseOne(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  options: { reason?: string | null; fromApproval?: boolean } = {},
): Promise<WorkOrderRead> {
  const order = await loadOrder(tx, orgId, id, true);
  if (order.status !== "draft") {
    if (order.status === "on_hold") refuse(`Work order ${order.number} is on hold for ${order.holdReason}.`, "work_order_on_hold", "Resume the work order before releasing it.", 409);
    refuse(`Work order ${order.number} is ${order.status} and cannot be released.`, "work_order_not_draft", "Release a draft work order or create a replacement.", 409);
  }
  const pendingGate = (await tx.execute(sql`
    select 1 from flow_gates where org_id=${orgId} and subject_kind='work_order'
      and subject_id=${id} and status in ('pending','escalated') limit 1`)).rows.length > 0;
  if (pendingGate && !options.fromApproval) {
    refuse(`Work order ${order.number} is awaiting approval.`, "work_order_pending_approval", "Resolve the pending work-order approval before releasing it.", 409);
  }
  if (!order.subsidiaryId) refuse(`Work order ${order.number} has no subsidiary.`, "work_order_subsidiary_required", "Choose an operating subsidiary before release.");
  const asOf = order.plannedStart ?? new Date().toISOString().slice(0, 10);
  const produced = await itemDetails(tx, orgId, order.producedItemId);
  const routing = await activeRouting(tx, orgId, order.producedItemId, produced.code?.trim() || produced.name, asOf, order.routingId);
  const issueLocationId = order.issueLocationId ?? routing.default_issue_location_id;
  const receiptLocationId = order.receiptLocationId ?? routing.default_receipt_location_id;
  if (!issueLocationId) refuse(`Work order ${order.number} has no issue location.`, "work_order_issue_location_required", "Choose an active stock location for material issue in the draft work order.");
  if (!receiptLocationId) refuse(`Work order ${order.number} has no receipt location.`, "work_order_receipt_location_required", "Choose an active stock location for finished goods in the draft work order.");
  await validateLocation(tx as Runner, orgId, order.subsidiaryId, issueLocationId, "outbound");
  await validateLocation(tx as Runner, orgId, order.subsidiaryId, receiptLocationId, "inbound");

  await tx.execute(sql`lock table bom_components in share mode`);
  const explosion = await explodeBom(tx, orgId, order.producedItemId, order.quantityOrdered, asOf);
  const directRows = await effectiveBomRows(tx, orgId, order.producedItemId, asOf);
  const revision = bomRevision(order.producedItemId, directRows);
  const operations = await tx.execute<{
    sequence: number; name: string; work_center_id: string; setup_minutes: string; run_minutes_per_unit: string;
    backflush_at: string; quality_gate: string;
  }>(sql`
    select sequence, name, work_center_id, setup_minutes::text, run_minutes_per_unit::text,
           backflush_at, quality_gate
      from mfg_routing_operations where org_id=${orgId} and routing_id=${routing.id}
     order by sequence for share`);
  if (!operations.rows.length) refuse(`Routing version ${routing.version} for ${produced.code?.trim() || produced.name} has no operations.`, "routing_operations_required", "Add an operation to the active routing version.");

  const directMake = new Set<string>();
  for (const row of directRows) {
    if (row.is_byproduct) continue;
    const policy = (await tx.execute<{ supply_method: string }>(sql`
      select supply_method from mfg_item_policies where org_id=${orgId} and item_id=${row.component_item_id}`)).rows[0];
    if (policy?.supply_method !== "make") continue;
    const code = row.component_code?.trim() || row.component_item_id;
    await activeRouting(tx, orgId, row.component_item_id, code, asOf, null);
    directMake.add(row.component_item_id);
  }
  const rootMaterialLines = directRows
    .filter((line) => !line.is_byproduct && !directMake.has(line.component_item_id))
    .map((line) => ({
      itemId: line.component_item_id, itemCode: line.component_code?.trim() || line.component_item_id,
      required: bomRequiredQuantity(order.quantityOrdered, line.quantity_per, line.scrap_pct).quantity,
      operationSeq: line.operation_seq, quantityPer: line.quantity_per, scrapPct: line.scrap_pct,
    }));
  const preparedMaterials = await releaseMaterials(tx, orgId, order, rootMaterialLines, issueLocationId);
  const producedProfile = (await tx.execute<{ costing_method: string; standard_cost: string | null }>(sql`
    select costing_method, standard_cost::text from item_inventory_profiles
     where org_id=${orgId} and item_id=${order.producedItemId} for share`)).rows[0];
  const standardCost = producedProfile?.costing_method === "standard" ? producedProfile.standard_cost : null;
  // Every operation snapshot resolves and freezes BEFORE the release status
  // mutation below: any refusal throws here and rolls the whole release
  // back, so operations are only ever inserted with complete coherent
  // values. There is no draft/null insert-then-fill path.
  const releaseDate = await releaseBusinessDate(tx, orgId);
  const functionalCurrency = await releaseFunctionalCurrency(tx, orgId, order);
  const snapshots = await resolveOperationReleaseSnapshots(tx, orgId, order, operations.rows, routing, releaseDate, functionalCurrency);
  const before = order;
  const released = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set routing_id=${routing.id}, routing_version=${routing.version}, bom_revision=${revision},
      standard_cost_snapshot=${standardCost}, issue_location_id=${issueLocationId}, receipt_location_id=${receiptLocationId},
      status='released', released_at=now(), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status='draft' returning ${workOrderColumns}`);
  const after = rowOrNotFound(released.rows);
  await auditChange(tx, {
    orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update",
    before: options.fromApproval ? { ...before, status: "pending_approval" } : before,
    after: {
      ...after,
      reason: options.reason?.trim() || (options.fromApproval ? "Approved through the work-order flow." : "Released."),
      release: {
        releaseDate,
        subsidiaryId: order.subsidiaryId,
        functionalCurrency,
        operations: snapshots.map((snapshot) => ({
          sequence: snapshot.sequence,
          workCenterId: snapshot.workCenterId,
          wageRowId: snapshot.wageId,
          wageEffectiveFrom: snapshot.wageEffectiveFrom,
          fxClass: snapshot.fxClass,
          fxRowId: snapshot.fxRowId,
          overheadCardIds: snapshot.overheadCardIds,
          burdenHash: snapshot.burdenHash,
          overheadHash: snapshot.overheadHash,
        })),
      },
    },
  });

  for (const [index, operation] of operations.rows.entries()) {
    const snapshot = snapshots[index]!;
    const plannedRunMinutes = decimalValue(mul(operation.run_minutes_per_unit, order.quantityOrdered), "plannedRunMinutes", "Reduce the order quantity or revise the routing run time so the planned minutes fit the supported range.");
    const inserted = await tx.execute(sql`
      insert into mfg_wo_operations (org_id, work_order_id, sequence, name, work_center_id,
        planned_setup_minutes, planned_run_minutes, quantity_planned, quality_gate, backflush_at,
        standard_labor_wage_id, standard_labor_effective_from, standard_labor_rate, standard_labor_currency,
        standard_labor_basis, standard_labor_annual_hours, standard_labor_final_rate,
        standard_labor_functional_currency, standard_labor_burden, standard_labor_burden_hash,
        standard_labor_fx_class, standard_labor_fx_rate, standard_labor_fx_row_id, standard_labor_fx_date,
        standard_labor_fx_source, standard_labor_fx_direction,
        overhead_snapshot, overhead_snapshot_hash,
        created_by, updated_by)
      values (${orgId}, ${id}, ${operation.sequence}, ${operation.name}, ${operation.work_center_id},
        ${operation.setup_minutes}, ${plannedRunMinutes},
        ${order.quantityOrdered}, ${operation.quality_gate}, ${operation.backflush_at},
        ${snapshot.wageId}, ${snapshot.wageEffectiveFrom}, ${snapshot.wageRate}, ${snapshot.wageCurrency},
        ${snapshot.wageBasis}, ${snapshot.wageAnnualHours}, ${snapshot.finalRate},
        ${snapshot.functionalCurrency},
        ${JSON.stringify(snapshot.burden)}::jsonb, ${snapshot.burdenHash},
        ${snapshot.fxClass}, ${snapshot.fxRate}, ${snapshot.fxRowId}, ${snapshot.fxDate},
        ${snapshot.fxSource}, ${snapshot.fxDirection},
        ${JSON.stringify(snapshot.overhead)}::jsonb, ${snapshot.overheadHash},
        ${actorId}, ${actorId}) returning id`);
    const operationId = inserted.rows[0]?.id;
    if (!operationId) refuse("A work-order operation snapshot was not saved.", "write_failed", "Retry the release; contact an administrator if it continues.");
    await auditChange(tx, {
      orgId, actorId, table: "mfg_wo_operations", rowId: String(operationId), action: "insert", before: null,
      after: {
        status: "pending", sequence: operation.sequence, name: operation.name, workCenterId: operation.work_center_id,
        quantityPlanned: order.quantityOrdered, backflushAt: operation.backflush_at, qualityGate: operation.quality_gate,
        standardLaborBurdenHash: snapshot.burdenHash, overheadSnapshotHash: snapshot.overheadHash,
      },
    });
  }
  for (const material of preparedMaterials) {
    const inserted = await tx.execute(sql`
      insert into mfg_wo_materials (org_id, work_order_id, component_item_id, required_qty,
        operation_seq, lot_serial_policy, shortage_qty, quantity_per, scrap_pct, created_by, updated_by)
      values (${orgId}, ${id}, ${material.itemId}, ${material.required}, ${material.operationSeq},
        ${material.tracking}, ${material.shortage}, ${material.quantityPer}, ${material.scrapPct ?? "0"},
        ${actorId}, ${actorId}) returning id`);
    const materialId = inserted.rows[0]?.id;
    if (!materialId) refuse("A work-order material snapshot was not saved.", "write_failed", "Retry the release; contact an administrator if it continues.");
    await auditChange(tx, {
      orgId, actorId, table: "mfg_wo_materials", rowId: String(materialId), action: "insert", before: null,
      after: {
        componentItemId: material.itemId, requiredQty: material.required, shortageQty: material.shortage,
        operationSeq: material.operationSeq, quantityPer: material.quantityPer, scrapPct: material.scrapPct,
      },
    });
  }

  const rootByproductIds = new Set(explosion.byproducts
    .filter((line) => line.parentItemId === order.producedItemId)
    .map((line) => line.itemId));
  const byproductQuantities = new Map<string, string>();
  for (const line of directRows) {
    if (!line.is_byproduct || !rootByproductIds.has(line.component_item_id)) continue;
    byproductQuantities.set(line.component_item_id,
      add(byproductQuantities.get(line.component_item_id) ?? "0", line.quantity_per));
  }
  for (const [itemId, quantityPer] of byproductQuantities) {
    const inserted = await tx.execute(sql`
      insert into mfg_wo_byproducts (org_id, work_order_id, item_id, quantity_per, created_by, updated_by)
      values (${orgId}, ${id}, ${itemId}, ${quantityPer}, ${actorId}, ${actorId}) returning id`);
    const byproductId = inserted.rows[0]?.id;
    if (!byproductId) refuse("A work-order by-product snapshot was not saved.", "write_failed", "Retry the release; contact an administrator if it continues.");
    await auditChange(tx, {
      orgId, actorId, table: "mfg_wo_byproducts", rowId: String(byproductId), action: "insert", before: null,
      after: { itemId, quantityPer },
    });
  }

  for (const row of directRows) {
    if (row.is_byproduct) continue;
    const policy = (await tx.execute<{ supply_method: string }>(sql`
      select supply_method from mfg_item_policies where org_id=${orgId} and item_id=${row.component_item_id}`)).rows[0];
    if (policy?.supply_method !== "make") continue;
    const childQty = bomRequiredQuantity(order.quantityOrdered, row.quantity_per, row.scrap_pct).quantity;
    const child = await insertDraft(tx, orgId, actorId, {
      producedItemId: row.component_item_id, quantityOrdered: childQty, subsidiaryId: order.subsidiaryId,
      issueLocationId, receiptLocationId: issueLocationId, plannedStart: order.plannedStart, plannedEnd: order.plannedEnd,
      source: "parent", sourceRefId: id, priority: order.priority as WorkOrderInput["priority"],
    }, { parentWoId: id });
    await releaseOne(tx, orgId, actorId, child.id, {
      reason: `Child of ${order.number}.`, fromApproval: options.fromApproval,
    });
  }
  return { ...after, pendingApproval: false };
}

export async function releaseWorkOrder(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  options: { reason?: string | null; fromApproval?: boolean } = {},
): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  if (!options.fromApproval && await hasWorkOrderSubmitFlow(tx, orgId)) {
    refuse("A configured work-order flow must handle this release request.", "work_order_approval_required", "Use the work-order Release action and configure an approval gate in Flows.", 409);
  }
  return releaseOne(tx, orgId, actorId, id, {
    reason: options.reason, fromApproval: options.fromApproval,
  });
}

export async function holdWorkOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string, reason: string): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const before = await loadOrder(tx, orgId, id, true);
  const holdReason = reason?.trim();
  if (!holdReason) refuse("A hold reason is required.", "hold_reason_required", "Enter the quality, material, or operating reason for the hold.");
  if (before.status === "on_hold") return { ...before, pendingApproval: false };
  if (before.status !== "released" && before.status !== "in_progress") {
    refuse(`Work order ${before.number} cannot be put on hold from ${before.status}.`, "invalid_work_order_transition", "Hold a released or in-progress work order.", 409);
  }
  const updated = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set status='on_hold', hold_reason=${holdReason}, hold_prior_status=${before.status},
      updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status=${before.status} returning ${workOrderColumns}`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update", before, after: { ...after, reason: holdReason } });
  return { ...after, pendingApproval: false };
}

async function heldRefusal(order: WorkOrderRow): Promise<void> {
  if (order.status === "on_hold") {
    refuse(`Work order ${order.number} is on hold for ${order.holdReason}.`, "work_order_on_hold", "Resume the work order before continuing.", 409);
  }
}

export async function resumeWorkOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const before = await loadOrder(tx, orgId, id, true);
  if (before.status !== "on_hold") {
    if (before.status === "released" || before.status === "in_progress") return { ...before, pendingApproval: false };
    refuse(`Work order ${before.number} is ${before.status} and cannot resume.`, "invalid_work_order_transition", "Resume an order that is on hold.", 409);
  }
  const prior = before.holdPriorStatus;
  if (prior !== "released" && prior !== "in_progress") {
    refuse(`Work order ${before.number} has no valid prior state for its hold.`, "hold_history_missing", "Restore the held work order's prior status to released or in progress before retrying.", 409);
  }
  const updated = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set status=${prior}, hold_reason=null, hold_prior_status=null,
      updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status='on_hold' returning ${workOrderColumns}`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update", before, after: { ...after, reason: "Resumed from hold." } });
  return { ...after, pendingApproval: false };
}

export async function startWorkOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const before = await loadOrder(tx, orgId, id, true);
  await heldRefusal(before);
  if (before.status === "in_progress") return { ...before, pendingApproval: false };
  if (before.status !== "released") refuse(`Work order ${before.number} cannot start from ${before.status}.`, "invalid_work_order_transition", "Start a released work order.", 409);
  const updated = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set status='in_progress', started_at=now(), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status='released' returning ${workOrderColumns}`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update", before, after: { ...after, reason: "Started." } });
  return { ...after, pendingApproval: false };
}

async function postedEntries(tx: SqlExecutor, orgId: string, order: WorkOrderRow) {
  return (await tx.execute<{ entry_number: string }>(sql`
    select entry.entry_number from journal_entries entry
     where entry.org_id=${orgId} and entry.origin='manufacturing'
       -- Live entries only: cancellation is blocked only by unreversed original manufacturing entries.
       and entry.status='posted' and entry.reverses_entry_id is null
       and entry.custom->>'work_order_number'=${order.number}
       and not exists (
         select 1 from journal_entries reversal
          where reversal.org_id=entry.org_id and reversal.reverses_entry_id=entry.id
            and reversal.status in ('posted','reversed')
       )
     order by entry.entry_number`)).rows;
}

async function descendants(tx: SqlExecutor, orgId: string, id: string) {
  return (await tx.execute<{
    id: string; number: string; status: string; started_at: Date | null; parent_wo_id: string;
    operation_started: boolean;
  }>(sql`
    with recursive children as (
      select id, number, status, started_at, parent_wo_id from mfg_work_orders
       where org_id=${orgId} and parent_wo_id=${id}
      union all
      select child.id, child.number, child.status, child.started_at, child.parent_wo_id
        from mfg_work_orders child join children parent on child.parent_wo_id=parent.id
       where child.org_id=${orgId}
    )
    select child.*, exists(select 1 from mfg_wo_operations op where op.org_id=${orgId}
      and op.work_order_id=child.id and (op.started_at is not null or op.status in ('running','paused','done'))) as operation_started
      from children child order by child.id`)).rows;
}

export async function cancelWorkOrder(tx: SqlExecutor, orgId: string, actorId: string, id: string, reason?: string | null): Promise<WorkOrderRead> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:mfg-work-order:${id}`}, 0))`);
  const pendingGates = await lockPendingApprovals(tx, orgId, id);
  const before = await loadOrder(tx, orgId, id, true);
  if (before.status === "cancelled") return { ...before, pendingApproval: false };
  if (before.status !== "draft" && before.status !== "released" && before.status !== "on_hold") {
    await heldRefusal(before);
    refuse(`Work order ${before.number} cannot be cancelled from ${before.status}.`, "invalid_work_order_transition", "Put the order on hold, then cancel it if nothing has posted.", 409);
  }
  const cancelReason = reason?.trim() || null;
  if (before.status !== "draft" && !cancelReason) {
    refuse(`Cancelling work order ${before.number} requires a reason.`, "cancel_reason_required", "Enter why the released work order is being cancelled.");
  }
  const entries = await postedEntries(tx, orgId, before);
  if (entries.length) {
    refuse(`Work order ${before.number} has posted manufacturing entries ${entries.map((entry) => entry.entry_number).join(", ")}.`, "work_order_has_postings", "Reverse the entry first, then cancel the work order.", 409);
  }
  const children = await descendants(tx, orgId, id);
  const childGates = new Map<string, PendingWorkOrderGate[]>();
  for (const summary of children) childGates.set(summary.id, await lockPendingApprovals(tx, orgId, summary.id));
  const lockedChildren: Array<{ summary: (typeof children)[number]; row: WorkOrderRow }> = [];
  for (const summary of children) lockedChildren.push({ summary, row: await loadOrder(tx, orgId, summary.id, true) });
  const startedChildren = lockedChildren.filter(({ summary, row }) =>
    row.startedAt || summary.operation_started || ["in_progress", "done", "closed"].includes(row.status));
  if (startedChildren.length) {
    refuse(`Work order ${before.number} has started child work orders ${startedChildren.map(({ row }) => row.number).join(", ")}.`, "started_child_work_orders", "Put each named child on hold, reverse any posted entries, cancel the child, then retry the parent cancellation.", 409);
  }
  for (const { row: childBefore } of lockedChildren) {
    if (childBefore.status === "cancelled") continue;
    const childEntries = await postedEntries(tx, orgId, childBefore);
    if (childEntries.length) {
      refuse(`Child work order ${childBefore.number} has posted manufacturing entries ${childEntries.map((entry) => entry.entry_number).join(", ")}.`, "work_order_has_postings", "Reverse the entry first, then cancel the child and parent work orders.", 409);
    }
    await cancelPendingApprovals(tx, orgId, childGates.get(childBefore.id) ?? [], actorId, cancelReason ?? `Parent ${before.number} cancelled.`);
    const childAfter = await tx.execute<WorkOrderRow>(sql`
      update mfg_work_orders set status='cancelled', cancel_reason=${cancelReason ?? `Parent ${before.number} cancelled.`},
        hold_reason=null, hold_prior_status=null, updated_by=${actorId}, updated_at=now()
       where org_id=${orgId} and id=${childBefore.id} and status=${childBefore.status} returning ${workOrderColumns}`);
    const cancelledChild = rowOrNotFound(childAfter.rows);
    await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: childBefore.id, action: "update", before: childBefore, after: { ...cancelledChild, reason: cancelReason ?? `Parent ${before.number} cancelled.` } });
  }
  await cancelPendingApprovals(tx, orgId, pendingGates, actorId, cancelReason ?? "Draft cancelled.");
  const updated = await tx.execute<WorkOrderRow>(sql`
    update mfg_work_orders set status='cancelled', cancel_reason=${cancelReason}, hold_reason=null, hold_prior_status=null,
      updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status=${before.status} returning ${workOrderColumns}`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: id, action: "update", before, after: { ...after, reason: cancelReason ?? "Draft cancelled." } });
  return { ...after, pendingApproval: false };
}

async function lockOperation(tx: SqlExecutor, orgId: string, workOrderId: string, operationId: string) {
  const order = await loadOrder(tx, orgId, workOrderId, true);
  const operation = (await tx.execute<{
    id: string; work_order_id: string; sequence: number; status: string; operator_user_id: string | null;
    pause_reason: string | null; started_at: Date | null;
  }>(sql`
    select id, work_order_id, sequence, status, operator_user_id, pause_reason, started_at
      from mfg_wo_operations where org_id=${orgId} and work_order_id=${workOrderId} and id=${operationId} for update`)).rows[0];
  if (!operation) throw new ManufacturingNotFoundError();
  return { order, operation };
}

export async function startWorkOrderOperation(tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string, operationId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const { order, operation: before } = await lockOperation(tx, orgId, workOrderId, operationId);
  await heldRefusal(order);
  if (order.status === "released") await startWorkOrder(tx, orgId, actorId, workOrderId);
  else if (order.status !== "in_progress") refuse(`Start work order ${order.number} before starting an operation.`, "work_order_not_started", "Start the released work order first.", 409);
  if (before.status === "running") return before;
  if (before.status !== "pending") refuse(`Operation ${before.sequence} cannot start from ${before.status}.`, "invalid_operation_transition", "Start a pending operation or resume a paused one.", 409);
  const updated = await tx.execute(sql`
    update mfg_wo_operations set status='running', operator_user_id=${actorId}, started_at=now(),
      pause_reason=null, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${operationId} and status='pending'
     returning id, work_order_id, sequence, status, operator_user_id, pause_reason, started_at`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_wo_operations", rowId: operationId, action: "update", before, after: { ...after, reason: "Operation started." } });
  await backflushOperation(tx, orgId, actorId, workOrderId, operationId, "start");
  return after;
}

export async function pauseWorkOrderOperation(tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string, operationId: string, reason: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const { order, operation: before } = await lockOperation(tx, orgId, workOrderId, operationId);
  await heldRefusal(order);
  const pauseReason = reason?.trim();
  if (!pauseReason) refuse(`Pausing operation ${before.sequence} requires a reason.`, "pause_reason_required", "Enter why the operation is paused.");
  if (before.status !== "running") refuse(`Operation ${before.sequence} cannot pause from ${before.status}.`, "invalid_operation_transition", "Pause an operation that is running.", 409);
  const updated = await tx.execute(sql`
    update mfg_wo_operations set status='paused', pause_reason=${pauseReason}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${operationId} and status='running'
     returning id, work_order_id, sequence, status, operator_user_id, pause_reason, started_at`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_wo_operations", rowId: operationId, action: "update", before, after: { ...after, reason: pauseReason } });
  return after;
}

export async function resumeWorkOrderOperation(tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string, operationId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const { order, operation: before } = await lockOperation(tx, orgId, workOrderId, operationId);
  await heldRefusal(order);
  if (before.status === "running") return before;
  if (before.status !== "paused") refuse(`Operation ${before.sequence} cannot resume from ${before.status}.`, "invalid_operation_transition", "Resume an operation that is paused.", 409);
  const updated = await tx.execute(sql`
    update mfg_wo_operations set status='running', pause_reason=null, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${operationId} and status='paused'
     returning id, work_order_id, sequence, status, operator_user_id, pause_reason, started_at`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_wo_operations", rowId: operationId, action: "update", before, after: { ...after, reason: "Operation resumed." } });
  return after;
}
