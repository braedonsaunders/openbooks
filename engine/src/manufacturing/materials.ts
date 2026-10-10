import {assertReceiptReworkIssue} from "./receipt-rework.ts";
import { lockManufacturingOrderExecutionAuthority } from "./authority.ts";
import { assertOperationInspectionAccepted, finishInspectionRework } from "./quality-execution.ts";
import { saleableLocation,unheldTracking,assertSaleableStock } from "../inventory/stock-eligibility.ts";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockSubcontractCustodyAuthority } from "../inventory/subcontract-custody.ts";
import { assertInspectionIdentifierScope } from "../inventory/inspections.ts";
import { sql } from "drizzle-orm";
import { add, cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { assertItemsActive } from "../inventory/item-active.ts";
import { assertMovementOwner, assertNoForeignOnHand, assertStockLocationAdmitsSubsidiary, resolveProfile } from "../inventory/profile-policy.ts";
import { InventoryError, type InventoryProfile, type Runner } from "../inventory/contracts.ts";
import { consumeLayers, recordConsumptions, resolveProvisionalUnitCost, type Consumption } from "../inventory/cost-layers.ts";
import { getOnHandWith, lockInventoryPosition, periodForDate, primaryBookId, subsidiaryCurrency } from "../inventory/position.ts";
import { inventoryOffsetAccountProblem, stockLocationDim } from "../inventory/journal.ts";
import { validateTrackingSelection } from "../inventory/tracking.ts";
import { bomRequiredQuantity, type BomQuantityBasis } from "../inventory/bom-scrap.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue } from "./master-support.ts";
import { getManufacturingPolicies } from "./policies.ts";
import { manufacturingControlAccount, postManufacturingEntry } from "./journal.ts";
import { absorbOperationConversion, type OperationTimeInput } from "./conversion.ts";

export interface MaterialIssueLine {
  materialId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
}

export interface OperationCompletion extends OperationTimeInput {
  doneQty: string;
  measuredQty?: string | null;
}

type WorkOrder = {
  id: string; number: string; status: string; hold_reason: string | null;
  subsidiary_id: string | null; issue_location_id: string | null;
  quantity_ordered: string; bom_revision: string | null; routing_version: number | null;
  receipt_rework_inspection_id:string|null;started_at: Date | null;
};

type Material = {
  id: string; component_item_id: string; component_code: string | null; component_name: string;
  required_qty: string; issued_qty: string; backflush_qty: string; operation_seq: number | null;
  lot_serial_policy: InventoryProfile["tracking"];
  quantity_per: string;quantity_basis:BomQuantityBasis;formula_output_quantity:string; scrap_pct: string;
};

type Operation = {
  id: string; sequence: number; status: string; quantity_planned: string;
  quantity_done: string; quantity_scrapped_here: string; measured_qty: string | null; quality_gate: string; backflush_at: string;
};

type IssueIntent = {
  material: Material;
  quantity: string;
  lotId: string | null;
  serialId: string | null;
  sourceReceiptMovementId?:string;
};

type PlannedIssue = IssueIntent & {
  profile: InventoryProfile;
  componentName: string;
  provisionalUnitCost: string | null;
  sourceMaterialIds: string[];
};

function refuse(message: string, code: string, remedy: string, status = 422): never {
  throw new ManufacturingError(message, { status, code, remedy });
}

function rowOrNotFound<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

async function loadOrder(tx: SqlExecutor, orgId: string, id: string, lock = false): Promise<WorkOrder> {
  return rowOrNotFound((await tx.execute<WorkOrder>(sql`
    select id, number, status, hold_reason, subsidiary_id, issue_location_id,
           quantity_ordered::text as quantity_ordered, bom_revision, routing_version, receipt_rework_inspection_id,started_at
      from mfg_work_orders where org_id=${orgId} and id=${id} ${lock ? sql`for update` : sql``}`)).rows);
}

function heldRefusal(order: WorkOrder): void {
  if (order.status === "on_hold") {
    const reason = order.hold_reason?.trim() || "no reason recorded";
    refuse(`Work order ${order.number} is on hold for ${reason}.`, "work_order_on_hold", "Resume the work order before issuing materials or completing an operation.", 409);
  }
}

async function lockMaterials(tx: SqlExecutor, orgId: string, workOrderId: string): Promise<Material[]> {
  return (await tx.execute<Material>(sql`
    select material.id, material.component_item_id, item.code as component_code, item.name as component_name,
           material.required_qty::text, material.issued_qty::text, material.backflush_qty::text,
           material.operation_seq, material.lot_serial_policy,
           material.quantity_per::text as quantity_per,
           material.scrap_pct::text as scrap_pct,material.quantity_basis,material.formula_output_quantity::text
      from mfg_wo_materials material
      join items item on item.org_id=material.org_id and item.id=material.component_item_id
     where material.org_id=${orgId} and material.work_order_id=${workOrderId}
     order by material.id for update of material`)).rows;
}

async function loadOperation(tx: SqlExecutor, orgId: string, workOrderId: string, operationId: string, lock = false): Promise<Operation> {
  const row = (await tx.execute<Operation>(sql`
    select operation.id, operation.sequence, operation.status,
           operation.quantity_planned::text as quantity_planned,
           operation.quantity_done::text as quantity_done,
           operation.quantity_scrapped_here::text as quantity_scrapped_here,
           operation.measured_qty::text as measured_qty,
           operation.quality_gate,
           operation.backflush_at
      from mfg_wo_operations operation
     where operation.org_id=${orgId} and operation.work_order_id=${workOrderId} and operation.id=${operationId}
     ${lock ? sql`for update of operation` : sql``}`)).rows[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

async function requireValueOrder(tx: SqlExecutor, orgId: string, actorId: string, order: WorkOrder): Promise<WorkOrder> {
  heldRefusal(order);
  if (order.status === "in_progress") return order;
  if (order.status !== "released") {
    refuse(`Work order ${order.number} cannot issue materials from ${order.status}.`, "invalid_work_order_transition", "Release the work order before issuing materials.", 409);
  }
  const updated = await tx.execute<{ id: string; started_at: Date }>(sql`
    update mfg_work_orders set status='in_progress', started_at=coalesce(started_at, now()),
      updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${order.id} and status='released'
     returning id, started_at`);
  const row = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: order.id, action: "update", before: order,
    after: { ...order, status: "in_progress", startedAt: row.started_at, reason: "Material execution started." } });
  return { ...order, status: "in_progress", started_at: row.started_at };
}

function materialName(material: Material): string {
  return material.component_code?.trim() || material.component_name;
}

function selectionKey(issue: IssueIntent): string {
  return `${issue.material.component_item_id}:${issue.lotId ?? ""}:${issue.serialId ?? ""}:${issue.sourceReceiptMovementId??""}`;
}

async function planIssues(
  tx: SqlExecutor,
  orgId: string,
  actorId:string,
  order: WorkOrder,
  intents: IssueIntent[],
  vendorCustody = false,
): Promise<PlannedIssue[]> {
  if (!order.subsidiary_id) refuse(`Work order ${order.number} has no subsidiary.`, "work_order_subsidiary_required", "Choose an operating subsidiary before releasing the work order.");
  if (!order.issue_location_id) refuse(`Work order ${order.number} has no issue location.`, "work_order_issue_location_required", "Choose an active stock location for material issue in the draft work order.");
  const componentIds = [...new Set(intents.map((issue) => issue.material.component_item_id))].sort();
  for (const itemId of componentIds) await lockInventoryPosition(tx as Runner, itemId, order.issue_location_id);
  const ctx = await loadSubsidiaryContext(tx, orgId);
  assertMovementOwner(ctx, order.subsidiary_id);
  await assertStockLocationAdmitsSubsidiary(tx as Runner, orgId, ctx, order.issue_location_id, order.subsidiary_id, "outbound");
  const names = await assertItemsActive(tx as Runner, orgId, componentIds, {
    inactiveRemedy: "reactivate the component before posting material movements",
    outsideOrganization: "A work-order material references an item outside this organization.",
  });
  const profiles = new Map<string, InventoryProfile>();
  for (const itemId of componentIds) profiles.set(itemId, await resolveProfile(orgId, itemId, tx as Runner, true));

  const available = new Map<string, string>();
  const planned: PlannedIssue[] = [];
  for (const issue of intents) {
    const profile = profiles.get(issue.material.component_item_id)!;
    const name = materialName(issue.material) || names.get(issue.material.component_item_id)!;
    if (profile.tracking !== issue.material.lot_serial_policy) {
      refuse(`Component ${name} tracking changed after the work-order material snapshot.`, "material_tracking_changed", "Review the component inventory profile and release a new work order.", 409);
    }
    if(order.receipt_rework_inspection_id) {
      const repair=await assertReceiptReworkIssue(tx,orgId,actorId,order.id,{itemId:issue.material.component_item_id,quantity:issue.quantity,lotId:issue.lotId,serialId:issue.serialId,stockLocationId:order.issue_location_id,subsidiaryId:order.subsidiary_id});
      issue.sourceReceiptMovementId=repair.receiptMovementId!;
    } else if(vendorCustody) {
      if(!issue.sourceReceiptMovementId || !(await tx.execute<{clear:boolean}>(sql`select ${unheldTracking(sql`${orgId}`,sql`${issue.lotId}::uuid`,sql`${issue.serialId}::uuid`)} as clear`)).rows[0]?.clear) {
        refuse('Vendor components are held or lack shipment evidence.','subcontract_component_unavailable','Resolve the stock hold and use the actual component shipment.');
      }
    } else await assertSaleableStock(tx as Runner,orgId,order.issue_location_id,{lotId:issue.lotId,serialId:issue.serialId});
    await validateTrackingSelection(tx as Runner, orgId, issue.material.component_item_id, order.issue_location_id, profile,
      { quantity: issue.quantity, lotId: issue.lotId, serialId: issue.serialId }, "issue");
    const key = selectionKey(issue);
    let onHand = available.get(key);
    if (onHand === undefined) {
      onHand = (await getOnHandWith(tx as Runner, orgId, issue.material.component_item_id, order.issue_location_id, {
        lotId: issue.lotId, serialId: issue.serialId, subsidiaryId: order.subsidiary_id,sourceReceiptMovementId:issue.sourceReceiptMovementId,
      })).quantity;
    }
    const positiveOnHand = cmp(onHand, "0") > 0 ? onHand : "0";
    const shortageUnits = toUnits(issue.quantity) - toUnits(positiveOnHand);
    if (shortageUnits > 0n) {
      await assertNoForeignOnHand(tx as Runner, orgId, issue.material.component_item_id, order.issue_location_id, order.subsidiary_id);
      if (vendorCustody || order.receipt_rework_inspection_id || !profile.allowNegativeInventory || profile.tracking !== "none") {
        refuse(`Component ${name} is short by ${fromUnits(shortageUnits)} for work order ${order.number}.`, "material_shortage", "Receive or transfer the named component into the work order issue location before posting.");
      }
    }
    const remaining = toUnits(positiveOnHand) - (toUnits(issue.quantity) < toUnits(positiveOnHand) ? toUnits(issue.quantity) : toUnits(positiveOnHand));
    available.set(key, fromUnits(remaining > 0n ? remaining : 0n));
    const provisionalUnitCost = shortageUnits > 0n
      ? await resolveProvisionalUnitCost(tx as Runner, orgId, profile, issue.material.component_item_id, order.subsidiary_id)
      : null;
    planned.push({ ...issue, profile, componentName: name, provisionalUnitCost, sourceMaterialIds: [issue.material.id] });
  }
  return planned;
}

async function trackedAvailability(
  tx: SqlExecutor,
  orgId: string,
  order: WorkOrder,
  itemId: string,
  tracking: InventoryProfile["tracking"],
): Promise<Array<{ id: string; quantity: string;lot_id?:string|null }>> {
  if (!order.subsidiary_id || !order.issue_location_id) return [];
  if (tracking === "lot") {
    return (await tx.execute<{ id: string; quantity: string }>(sql`
      select source.lot_id as id, sum(layer.remaining_quantity)::text as quantity
        from cost_layers layer
        join inventory_movements source on source.org_id=layer.org_id and source.id=layer.source_movement_id
        join lots lot on lot.org_id=source.org_id and lot.id=source.lot_id
       where layer.org_id=${orgId} and layer.subsidiary_id=${order.subsidiary_id}
         and layer.item_id=${itemId} and layer.stock_location_id=${order.issue_location_id}
         and layer.remaining_quantity>0 and source.lot_id is not null
       and ${saleableLocation(sql`layer.org_id`,sql`layer.stock_location_id`)} and ${unheldTracking(sql`source.org_id`,sql`source.lot_id`,sql`source.serial_id`)}
       group by source.lot_id,lot.expires_on order by lot.expires_on nulls last,min(source.moved_at), min(source.created_at), source.lot_id`)).rows;
  }
  if (tracking === "serial" || tracking === "lot_serial") {
    return (await tx.execute<{ id: string; quantity: string;lot_id:string|null }>(sql`
      select source.lot_id,source.serial_id as id, sum(layer.remaining_quantity)::text as quantity
        from cost_layers layer
        join inventory_movements source on source.org_id=layer.org_id and source.id=layer.source_movement_id
        join serials serial on serial.org_id=source.org_id and serial.id=source.serial_id
        left join lots lot on lot.org_id=source.org_id and lot.id=source.lot_id
       where layer.org_id=${orgId} and layer.subsidiary_id=${order.subsidiary_id}
         and layer.item_id=${itemId} and layer.stock_location_id=${order.issue_location_id}
         and layer.remaining_quantity>0 and source.serial_id is not null
         and serial.status='in_stock' and serial.current_stock_location_id=${order.issue_location_id}
       and ${saleableLocation(sql`layer.org_id`,sql`layer.stock_location_id`)} and ${unheldTracking(sql`source.org_id`,sql`source.lot_id`,sql`source.serial_id`)}
       group by source.serial_id,source.lot_id,lot.expires_on order by lot.expires_on nulls last,min(source.moved_at), min(source.created_at), source.serial_id`)).rows;
  }
  return [];
}

async function backflushIntents(
  tx: SqlExecutor,
  orgId: string,
  order: WorkOrder,
  materials: Material[],
  operation: Operation,
  basisQuantity: string,
): Promise<IssueIntent[]> {
  const required = materials.filter((material) => material.operation_seq === operation.sequence);
  const profileByItem = new Map<string, InventoryProfile>();
  for (const itemId of [...new Set(required.map((material) => material.component_item_id))].sort()) {
    profileByItem.set(itemId, await resolveProfile(orgId, itemId, tx as Runner, true));
  }
  const remaining = new Map<string, string>();
  const intents: IssueIntent[] = [];
  for (const material of required) {
    const requirement = bomRequiredQuantity(basisQuantity, material.quantity_per, material.scrap_pct,{quantityBasis:material.quantity_basis,formulaOutputQuantity:material.formula_output_quantity});
    if (cmp(requirement.quantity, "0") <= 0 && cmp(requirement.exactQuantity, "0") > 0) {
      refuse(`Component ${materialName(material)} requires ${requirement.exactQuantity}, below the 0.0001 unit precision.`, "material_quantity_below_precision", "Increase the operation quantity or revise the BOM quantity per.");
    }
    if (cmp(requirement.quantity, "0") <= 0) continue;
    const profile = profileByItem.get(material.component_item_id)!;
    if (material.lot_serial_policy !== profile.tracking) {
      refuse(`Component ${materialName(material)} tracking changed after the work-order material snapshot.`, "material_tracking_changed", "Review the component inventory profile and release a new work order.", 409);
    }
    if (profile.tracking === "none") {
      intents.push({ material, quantity: requirement.quantity, lotId: null, serialId: null });
      continue;
    }
    const lots = await trackedAvailability(tx, orgId, order, material.component_item_id, profile.tracking);
    let needed = toUnits(requirement.quantity);
    if (profile.tracking === "lot") {
      for (const candidate of lots) {
        const key = `${material.component_item_id}:${candidate.id}`;
        const open = remaining.has(key) ? remaining.get(key)! : candidate.quantity;
        const openUnits = toUnits(open);
        if (openUnits <= 0n || needed <= 0n) continue;
        const take = openUnits < needed ? openUnits : needed;
        intents.push({ material, quantity: fromUnits(take), lotId: candidate.id, serialId: null });
        remaining.set(key, fromUnits(openUnits - take));
        needed -= take;
      }
    } else {
      if (needed % 10_000n !== 0n) {
        refuse(`Component ${materialName(material)} needs ${requirement.quantity}, which cannot be allocated as whole serials.`, "serial_material_quantity_invalid", "Revise the BOM quantity per so the required serial count is a whole number.");
      }
      for (const candidate of lots) {
        const key = `${material.component_item_id}:${candidate.id}`;
        if ((remaining.get(key) ?? candidate.quantity) === "0.0000" || needed <= 0n) continue;
        intents.push({ material, quantity: "1.0000", lotId: candidate.lot_id??null, serialId: candidate.id });
        remaining.set(key, "0.0000");
        needed -= 10_000n;
      }
    }
    if (needed > 0n) {
      await assertNoForeignOnHand(tx as Runner, orgId, material.component_item_id, order.issue_location_id!, order.subsidiary_id!);
      refuse(`Component ${materialName(material)} is short by ${fromUnits(needed)} for operation ${operation.sequence}.`, "backflush_lot_shortage", "Receive or transfer the missing component into the work order issue location before starting or completing the operation.");
    }
  }
  return intents;
}

async function recordLayerDrawdown(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  movementId: string,
  consumptions: Consumption[],
  actorId: string,
): Promise<void> {
  if (!consumptions.length) return;
  const ids = [...new Set(consumptions.map((item) => item.layerId))].sort();
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const before = (await tx.execute<{ id: string; remaining_quantity: string }>(sql`
    select id, remaining_quantity::text from cost_layers where org_id=${orgId} and id in (${idList}) order by id for update`)).rows;
  if (before.length !== ids.length) throw new InventoryError("A component cost layer changed before work-order issue.");
  await recordConsumptions(tx as Runner, orgId, subsidiaryId, consumptions, movementId, actorId);
  const after = (await tx.execute<{ id: string; remaining_quantity: string }>(sql`
    select id, remaining_quantity::text from cost_layers where org_id=${orgId} and id in (${idList}) order by id`)).rows;
  const drawn = new Map<string, string>();
  for (const row of consumptions) drawn.set(row.layerId, add(drawn.get(row.layerId) ?? "0", row.quantity));
  const beforeById = new Map(before.map((row) => [row.id, row.remaining_quantity]));
  for (const row of after) {
    if (cmp(add(beforeById.get(row.id)!, neg(drawn.get(row.id)!)), row.remaining_quantity) !== 0) {
      throw new InventoryError("A component cost layer did not record its complete work-order issue.");
    }
  }
  const audit = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from cost_layer_consumptions where org_id=${orgId} and issue_movement_id=${movementId}`);
  if (audit.rows[0]?.count !== consumptions.length) throw new InventoryError("Component layer consumption evidence was not fully recorded.");
}

async function postMaterialIssue(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  order: WorkOrder,
  plannedIntents: PlannedIssue[],
  deltas: Map<string, { issued: string; backflush: string }>,
  evidence: Record<string, unknown> = {},
): Promise<{ entryId: string | null; movementIds: string[] }> {
  if (!plannedIntents.length) return { entryId: null, movementIds: [] };
  const merged = new Map<string, PlannedIssue>();
  for (const issue of plannedIntents) {
    const key = selectionKey(issue);
    const prior = merged.get(key);
    if (prior) {
      prior.quantity = add(prior.quantity, issue.quantity);
      if (!prior.sourceMaterialIds.includes(issue.material.id)) prior.sourceMaterialIds.push(issue.material.id);
    } else merged.set(key, { ...issue, sourceMaterialIds: [issue.material.id] });
  }
  const planned = [...merged.values()];
  const wip = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgWip");
  if (!order.subsidiary_id || !order.issue_location_id || !order.bom_revision || order.routing_version === null) {
    refuse(`Work order ${order.number} is missing its released posting evidence.`, "work_order_snapshot_missing", "Release a new work order from a valid BOM and routing version.", 409);
  }
  const date = await businessToday(orgId);
  const periodId = await periodForDate(orgId, date, tx);
  if (!periodId) refuse(`No accounting period is open for material issue on ${date}.`, "posting_period_missing", "Open the accounting period or choose an allowed posting date.");
  const bookId = await primaryBookId(orgId, tx);
  const currency = await subsidiaryCurrency(orgId, order.subsidiary_id, tx);
  const locationId = await stockLocationDim(tx, orgId, order.issue_location_id, null);
  const lines: Array<{ accountId: string; amount: string; locationId: string | null; memo: string }> = [];
  const movements: Array<{ issue: PlannedIssue; cost: string; unitCost: string; consumptions: Consumption[]; shortfall: string }> = [];
  let totalCost = "0";
  for (const issue of planned) {
    const onHand = await getOnHandWith(tx as Runner, orgId, issue.material.component_item_id, order.issue_location_id!, {
      lotId: issue.lotId, serialId: issue.serialId, subsidiaryId: order.subsidiary_id,sourceReceiptMovementId:issue.sourceReceiptMovementId,
    });
    const { cost, unitCost, consumptions, shortfallQuantity } = await consumeLayers(
      tx as Runner, orgId, issue.profile, issue.material.component_item_id, order.issue_location_id!, issue.quantity,
      onHand, issue.provisionalUnitCost ?? onHand.unitCost, { lotId: issue.lotId, serialId: issue.serialId,sourceReceiptMovementId:issue.sourceReceiptMovementId },
      order.subsidiary_id, actorId,
    );
    if (!isZero(shortfallQuantity) && (issue.sourceReceiptMovementId || !issue.profile.allowNegativeInventory || issue.profile.tracking !== "none")) {
      refuse(`Component ${issue.componentName} is short by ${shortfallQuantity} for work order ${order.number}.`, "material_shortage", "Receive or transfer the named component into the work order issue location before posting.");
    }
    const accountProblem = inventoryOffsetAccountProblem(issue.profile.assetAccountId, wip, "manufacturing WIP offset");
    if (accountProblem) throw new InventoryError(accountProblem);
    lines.push({ accountId: issue.profile.assetAccountId, amount: neg(cost), locationId, memo: `${order.number} material issue: ${issue.componentName}` });
    totalCost = add(totalCost, cost);
    movements.push({ issue, cost, unitCost, consumptions, shortfall: shortfallQuantity });
  }
  lines.unshift({ accountId: wip, amount: totalCost, locationId, memo: `${order.number} material WIP` });
  const entryId = await postManufacturingEntry(tx as Runner, {
    orgId, bookId, subsidiaryId: order.subsidiary_id, actorId, currency, periodId, date,
    entryNumber: `MFG-MAT-${date}-${randomUUID().slice(0, 12)}`,
    memo: `Material issue for work order ${order.number}`, lines,
    custom: {
      workOrderNumber: order.number, bomRevision: order.bom_revision, routingVersion: String(order.routing_version), ...evidence,
    },
  });
  const movementIds: string[] = [];
  for (const { issue, cost, unitCost, consumptions, shortfall } of movements) {
    const quantity = neg(issue.quantity);
    const insert = await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${order.subsidiary_id}, ${issue.material.component_item_id}, 'assembly_consume', ${date},
        ${order.issue_location_id}, ${issue.lotId}, ${issue.serialId}, ${quantity}, ${unitCost}, ${neg(cost)},
        ${entryId}, 'posted', ${`${order.number} material issue`}, ${actorId}, ${actorId}) returning id`);
    const movementId = rowOrNotFound(insert.rows).id;
    movementIds.push(movementId);
    await recordLayerDrawdown(tx, orgId, order.subsidiary_id, movementId, consumptions, actorId);
    if (!isZero(shortfall)) {
      const provisional = await tx.execute<{ id: string }>(sql`
        insert into inventory_provisional_costs
          (org_id, subsidiary_id, item_id, stock_location_id, issue_movement_id, original_quantity,
           remaining_quantity, provisional_unit_cost, cost_basis, created_by, updated_by)
        values (${orgId}, ${order.subsidiary_id}, ${issue.material.component_item_id}, ${order.issue_location_id},
          ${movementId}, ${shortfall}, ${shortfall}, ${issue.provisionalUnitCost}, ${issue.profile.negativeCostBasis},
          ${actorId}, ${actorId}) returning id`);
      rowOrNotFound(provisional.rows);
    }
    if (issue.serialId) {
      const serial = await tx.execute<{ id: string }>(sql`
        update serials set status='shipped', current_stock_location_id=null, updated_at=now(), updated_by=${actorId}
         where org_id=${orgId} and id=${issue.serialId} and status='in_stock'
           and current_stock_location_id=${order.issue_location_id} returning id`);
      if (serial.rows.length !== 1) throw new InventoryError(`Serial component ${issue.serialId} changed before work-order issue.`);
    }
    await auditChange(tx, { orgId, actorId, table: "inventory_movements", rowId: movementId, action: "insert", before: null,
      after: { itemId: issue.material.component_item_id, quantity, lotId: issue.lotId, serialId: issue.serialId, totalValue: neg(cost), journalEntryId: entryId, kind: "assembly_consume" } });
  }
  for (const materialId of [...deltas.keys()].sort()) {
    const delta = deltas.get(materialId)!;
    const material = plannedIntents.find((issue) => issue.material.id === materialId)?.material;
    if (!material) throw new ManufacturingError("A work-order material update lost its source line.", { code: "material_update_missing", remedy: "Reload the work order and retry the material issue." });
    const issued = add(material.issued_qty, delta.issued);
    const backflush = add(material.backflush_qty, delta.backflush);
    const updated = await tx.execute(sql`
      update mfg_wo_materials set issued_qty=${issued}, backflush_qty=${backflush}, updated_by=${actorId}, updated_at=now()
       where org_id=${orgId} and work_order_id=${order.id} and id=${materialId}
         and issued_qty=${material.issued_qty} and backflush_qty=${material.backflush_qty} returning id`);
    if (updated.rows.length !== 1) refuse(`Material line ${materialId} changed while work order ${order.number} was being issued.`, "material_line_changed", "Reload the work order and retry.", 409);
    await auditChange(tx, { orgId, actorId, table: "mfg_wo_materials", rowId: materialId, action: "update",
      before: { issuedQty: material.issued_qty, backflushQty: material.backflush_qty },
      after: { issuedQty: issued, backflushQty: backflush, journalEntryId: entryId } });
  }
  return { entryId, movementIds };
}

export async function issueMaterials(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  workOrderId: string,
  lines: MaterialIssueLine[],
): Promise<{ entryId: string | null; movementIds: string[] }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  if (!Array.isArray(lines) || lines.length === 0) refuse("Choose at least one material line to issue.", "issue_lines_required", "Select work-order material lines and enter quantities to issue.");
  const order = await loadOrder(tx, orgId, workOrderId, true);
  heldRefusal(order);
  if (order.status !== "released" && order.status !== "in_progress") {
    refuse(`Work order ${order.number} cannot issue materials from ${order.status}.`, "invalid_work_order_transition", "Release the work order before issuing materials.", 409);
  }
  const materials = await lockMaterials(tx, orgId, workOrderId);
  const byId = new Map(materials.map((material) => [material.id, material]));
  const grouped = new Map<string, { material: Material; quantity: string; lotId: string | null; serialId: string | null }>();
  const seenSerials = new Set<string>();
  for (const line of lines) {
    const material = byId.get(line.materialId);
    if (!material) throw new ManufacturingNotFoundError();
    const quantity = decimalValue(line.quantity, "quantity", "Enter a positive exact quantity with no more than four decimal places.");
    if (compareDecimal(quantity, "0") <= 0) refuse(`Issue quantity for ${materialName(material)} must be positive.`, "invalid_issue_quantity", "Enter a positive exact quantity with no more than four decimal places.");
    if (line.serialId && seenSerials.has(line.serialId)) refuse(`Serial ${line.serialId} appears more than once in the issue selection.`, "duplicate_serial_selection", "Select each serial number once.");
    if (line.serialId) seenSerials.add(line.serialId);
    const lotId = line.lotId ?? null;
    const serialId = line.serialId ?? null;
    const key = `${material.id}:${lotId ?? ""}:${serialId ?? ""}`;
    const prior = grouped.get(key);
    if (prior) {
      if (serialId) refuse(`Serial ${serialId} appears more than once in the issue selection.`, "duplicate_serial_selection", "Select each serial number once.");
      prior.quantity = add(prior.quantity, quantity);
    } else grouped.set(key, { material, quantity, lotId, serialId });
  }
  const intents: IssueIntent[] = [...grouped.values()];
  const planned = await planIssues(tx, orgId, actorId,order, intents);
  const updatedOrder = await requireValueOrder(tx, orgId, actorId, order);
  const deltas = new Map<string, { issued: string; backflush: string }>();
  for (const issue of planned) {
    const delta = deltas.get(issue.material.id) ?? { issued: "0", backflush: "0" };
    delta.issued = add(delta.issued, issue.quantity);
    deltas.set(issue.material.id, delta);
  }
  // The plan was checked before the state transition. postMaterialIssue rechecks under the same row and position locks.
  return postMaterialIssue(tx, orgId, actorId, updatedOrder, planned, deltas);
}

/** A vendor drawdown consumes only this subcontract's actual transferred layers. */
export async function consumeSubcontractMaterials(
  tx:SqlExecutor,orgId:string,actorId:string,subcontractId:string,requestKey:string,
  raw:Array<{shipmentId:string;quantity:string}>,
) {
  if(!isUuid(subcontractId)||!isUuid(requestKey)||!Array.isArray(raw)||!raw.length||raw.length>100||raw.some(line=>!line||typeof line!=="object"||!isUuid(line.shipmentId))) throw new ManufacturingNotFoundError();
  const lines=raw.map(line=>({shipmentId:line.shipmentId,quantity:fromUnits(toUnits(decimalValue(line.quantity,'quantity','Enter a positive component quantity.')))})).sort((a,b)=>a.shipmentId.localeCompare(b.shipmentId));
  if(new Set(lines.map(line=>line.shipmentId)).size!==lines.length || lines.some(line=>cmp(line.quantity,'0')<=0)) refuse('Select distinct shipments with positive consumed quantities.','subcontract_consumption_invalid','Record each actual shipment once with the quantity the vendor used.');
  await assertManufacturingFeature(tx,orgId,'manufacturingSubcontract');
  const contract=(await tx.execute<{workOrderId:string;custodyLocationId:string;vendorId:string;status:string}>(sql`select work_order_id as "workOrderId",custody_location_id as "custodyLocationId",vendor_id as "vendorId",status from mfg_subcontracts where org_id=${orgId} and id=${subcontractId}`)).rows[0];
  if(!contract) throw new ManufacturingNotFoundError();
  const scope=await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,contract.workOrderId,null,contract.custodyLocationId);
  const original=await loadOrder(tx,orgId,contract.workOrderId,true);
  const custody=await lockSubcontractCustodyAuthority(tx,orgId,actorId,original.subsidiary_id!,contract.custodyLocationId);
  if(!custody || custody.vendorId!==contract.vendorId) throw new ManufacturingNotFoundError();
  const prior=(await tx.execute<{id:string;custom:Record<string,unknown>;status:string}>(sql`select id,custom,status from journal_entries where org_id=${orgId} and origin='manufacturing' and reverses_entry_id is null and custom->>'subcontract_consumption_key'=${requestKey} for share`)).rows[0];
  if(prior) {
    if(prior.custom.work_order_number!==original.number || prior.custom.subcontract_id!==subcontractId || canonicalJson(prior.custom.subcontract_consumption)!==canonicalJson(lines)) refuse('This consumption key already belongs to another request.','idempotency_key_conflict','Reload the subcontract or use a new request for a separate consumption.');
    if(prior.status!=='posted'||(await tx.execute(sql`select id from journal_entries where org_id=${orgId} and reverses_entry_id=${prior.id} and status='posted' limit 1`)).rows.length) refuse('This vendor consumption was reversed.','subcontract_consumption_reversed','Use a new request for a new vendor consumption; the reversal retains its history.');
    const movementIds=(await tx.execute<{id:string}>(sql`select id from inventory_movements where org_id=${orgId} and journal_entry_id=${prior.id} and kind='assembly_consume' order by id`)).rows.map(row=>row.id);
    return {entryId:prior.id,movementIds,replayed:true};
  }
  heldRefusal(original);
  if(!['ready','sent'].includes(contract.status)||!['released','in_progress'].includes(original.status)) refuse('This order is not open for vendor consumption.','subcontract_not_open','Resume the order and use its open subcontract.');
  const pinned=(await tx.execute(sql`select id from mfg_subcontracts where org_id=${orgId} and id=${subcontractId} and status in('ready','sent') for update`)).rows[0];
  if(!pinned) throw new ManufacturingNotFoundError();
  const materials=await lockMaterials(tx,orgId,original.id),byId=new Map(materials.map(material=>[material.id,material]));
  const intents:IssueIntent[]=[];
  for(const line of lines) {
    const shipment=(await tx.execute<{materialId:string;receiptId:string;lotId:string|null;serialId:string|null}>(sql`select shipment.material_id as "materialId",shipment.to_movement_id as "receiptId",inbound.lot_id as "lotId",inbound.serial_id as "serialId"
      from mfg_subcontract_shipments shipment join inventory_movements inbound on inbound.org_id=shipment.org_id and inbound.id=shipment.to_movement_id
      join inventory_movements outbound on outbound.org_id=shipment.org_id and outbound.id=shipment.from_movement_id
      where shipment.org_id=${orgId} and shipment.id=${line.shipmentId} and shipment.subcontract_id=${subcontractId}
        and inbound.kind='transfer_in' and inbound.status='posted' and inbound.stock_location_id=${contract.custodyLocationId} and inbound.subsidiary_id=${original.subsidiary_id}
        and outbound.kind='transfer_out' and outbound.status='posted' and inbound.paired_movement_id=outbound.id
        and not exists(select 1 from inventory_movements reversal where reversal.org_id=shipment.org_id and reversal.reverses_movement_id in(inbound.id,outbound.id) and reversal.status='posted')
      for share of shipment,inbound,outbound`)).rows[0];
    if(!shipment) refuse('The component shipment is missing or reversed.','subcontract_shipment_unavailable','Use the live shipment that delivered these components to the vendor.');
    const material=byId.get(shipment.materialId);
    if(!material) throw new ManufacturingNotFoundError();
    await assertInspectionIdentifierScope(tx,orgId,actorId,material.component_item_id,scope,shipment);
    intents.push({material,quantity:line.quantity,lotId:shipment.lotId,serialId:shipment.serialId,sourceReceiptMovementId:shipment.receiptId});
  }
  const vendorOrder={...original,issue_location_id:contract.custodyLocationId};
  const planned=await planIssues(tx,orgId,actorId,vendorOrder,intents,true);
  const started=await requireValueOrder(tx,orgId,actorId,original);
  const deltas=new Map<string,{issued:string;backflush:string}>();
  for(const intent of planned) {
    const delta=deltas.get(intent.material.id)??{issued:'0',backflush:'0'};
    delta.issued=add(delta.issued,intent.quantity);deltas.set(intent.material.id,delta);
  }
  const result=await postMaterialIssue(tx,orgId,actorId,{...started,issue_location_id:contract.custodyLocationId},planned,deltas,{subcontract_id:subcontractId,subcontract_consumption_key:requestKey,subcontract_consumption:lines});
  return {...result,replayed:false};
}

export async function backflushOperation(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  workOrderId: string,
  operationId: string,
  trigger: "start" | "finish",
): Promise<{ entryId: string | null; movementIds: string[]; fired: boolean }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const order = await loadOrder(tx, orgId, workOrderId, true);
  heldRefusal(order);
  const operation = await loadOperation(tx, orgId, workOrderId, operationId, true);
  if (operation.backflush_at !== trigger) return { entryId: null, movementIds: [], fired: false };
  const expectedStatus = trigger === "start" ? "running" : "done";
  if (order.status !== "in_progress" || operation.status !== expectedStatus) {
    refuse(`Operation ${operation.sequence} cannot backflush at ${trigger} while it is ${operation.status}.`, "invalid_operation_transition", `Set operation ${operation.sequence} to ${expectedStatus} before its ${trigger} backflush.`, 409);
  }
  await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  const prior = (await tx.execute<{ id: string }>(sql`
    select id from journal_entries where org_id=${orgId} and origin='manufacturing'
      and custom->>'work_order_number'=${order.number}
      and custom->>'operation_id'=${operationId} and custom->>'backflush_trigger'=${trigger} limit 1`)).rows[0];
  if (prior) return { entryId: prior.id, movementIds: [], fired: true };
  const materials = await lockMaterials(tx, orgId, workOrderId);
  const operationMaterials = materials.filter((material) => material.operation_seq === operation.sequence);
  if (operationMaterials.length) {
    if (!order.issue_location_id) refuse(`Work order ${order.number} has no issue location.`, "work_order_issue_location_required", "Choose an active stock location for material issue in the draft work order.");
    const itemIds = [...new Set(operationMaterials.map((material) => material.component_item_id))].sort();
    for (const itemId of itemIds) await lockInventoryPosition(tx as Runner, itemId, order.issue_location_id);
  }
  const intents = await backflushIntents(tx, orgId, order, materials, operation,
    trigger === "start" ? operation.quantity_planned : add(operation.quantity_done, operation.quantity_scrapped_here));
  const deltas = new Map<string, { issued: string; backflush: string }>();
  for (const issue of intents) {
    const delta = deltas.get(issue.material.id) ?? { issued: "0", backflush: "0" };
    delta.backflush = add(delta.backflush, issue.quantity);
    deltas.set(issue.material.id, delta);
  }
  if (!intents.length) return { entryId: null, movementIds: [], fired: true };
  const planned = await planIssues(tx, orgId, actorId,order, intents);
  const result = await postMaterialIssue(tx, orgId, actorId, order, planned, deltas, {
    operation_id: operationId, operation_sequence: String(operation.sequence), backflush_trigger: trigger,
  });
  return { ...result, fired: true };
}

export async function completeWorkOrderOperation(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  workOrderId: string,
  operationId: string,
  input: OperationCompletion,
): Promise<{ id: string; sequence: number; status: string; quantity_done: string; measured_qty: string | null }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingOrderExecutionAuthority(tx,orgId,actorId,workOrderId);
  const order = await loadOrder(tx, orgId, workOrderId, true);
  heldRefusal(order);
  const operation = await loadOperation(tx, orgId, workOrderId, operationId, true);
  const doneQty = decimalValue(input.doneQty, "doneQty", "Enter the measured quantity completed as a positive exact amount.");
  if (compareDecimal(doneQty, "0") < 0) refuse(`Completed quantity for operation ${operation.sequence} cannot be negative.`, "invalid_done_quantity", "Enter a non-negative exact completed quantity.");
  const measuredQty = input.measuredQty == null ? null : decimalValue(input.measuredQty, "measuredQty", "Enter a non-negative exact measured quantity.");
  if (measuredQty !== null && compareDecimal(measuredQty, "0") < 0) refuse(`Measured quantity for operation ${operation.sequence} cannot be negative.`, "invalid_measured_quantity", "Enter a non-negative exact measured quantity.");
  if (operation.quality_gate === "measure" && measuredQty === null) {
    refuse(`Operation ${operation.sequence} requires a measured quantity at its quality gate.`, "measured_quantity_required", "Enter measuredQty before completing this operation.");
  }
  if (operation.status === "done") {
    if (cmp(operation.quantity_done, doneQty) === 0 && operation.measured_qty === measuredQty) {
      return { id: operation.id, sequence: operation.sequence, status: operation.status, quantity_done: operation.quantity_done, measured_qty: operation.measured_qty };
    }
    refuse(`Operation ${operation.sequence} is already complete.`, "operation_already_complete", "Use a controlled correction to change a completed operation.", 409);
  }
  if (operation.status !== "running") {
    refuse(`Operation ${operation.sequence} cannot complete from ${operation.status}.`, "invalid_operation_transition", "Complete an operation that is running.", 409);
  }
  const subcontract=(await tx.execute<{id:string;returned:string;final:boolean}>(sql`select contract.id,
    (select coalesce(sum(quantity),0)::text from mfg_subcontract_returns where org_id=contract.org_id and subcontract_id=contract.id) as returned,
    exists(select 1 from mfg_subcontract_returns where org_id=contract.org_id and subcontract_id=contract.id and request_snapshot->>'finish'='true') as final
    from mfg_subcontracts contract where contract.org_id=${orgId} and contract.operation_id=${operationId} and contract.status<>'cancelled' for share`)).rows[0];
  if(subcontract) {
    await assertManufacturingFeature(tx,orgId,'manufacturingSubcontract');
    if(!subcontract.final||cmp(subcontract.returned,doneQty)!==0) refuse('This operation must finish through its actual vendor deliveries.','subcontract_return_required','Record the final delivery on the subcontract; its accumulated returned quantity becomes the operation’s completed quantity.');
  }
  await assertOperationInspectionAccepted(tx,orgId,operationId,doneQty);
  const policies = await getManufacturingPolicies(tx, orgId);
  const toleranceUnits = toUnits(policies.completionTolerancePct);
  const maximumUnits = toUnits(operation.quantity_planned) * (1_000_000n + toleranceUnits) / 1_000_000n;
  if (toUnits(add(doneQty, operation.quantity_scrapped_here)) > maximumUnits) {
    refuse(`Operation ${operation.sequence} completed quantity ${doneQty} exceeds its planned quantity ${operation.quantity_planned} plus the ${policies.completionTolerancePct}% completion tolerance.`, "completion_tolerance_exceeded", "Revise the order quantity.");
  }
  // Conversion cost is absorbed in the same transaction as the transition,
  // so an operation is never done without its labor and overhead in WIP.
  const conversion = await absorbOperationConversion(tx, orgId, actorId, order, operationId, doneQty, input);
  const updated = await tx.execute<{ id: string; sequence: number; status: string; quantity_done: string; measured_qty: string | null }>(sql`
    update mfg_wo_operations set status='done', quantity_done=${doneQty}, measured_qty=${measuredQty},
      actual_setup_minutes=${conversion.setupMinutes}, actual_run_minutes=${conversion.runMinutes},
      actual_labor_minutes=${conversion.laborMinutes},
      completed_at=now(), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${operationId} and status='running'
     returning id, sequence, status, quantity_done::text, measured_qty::text`);
  const after = rowOrNotFound(updated.rows);
  if (updated.rows.length !== 1) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_wo_operations", rowId: operationId, action: "update",
    before: operation, after: { ...after, actualSetupMinutes: conversion.setupMinutes, actualRunMinutes: conversion.runMinutes,
      actualLaborMinutes: conversion.laborMinutes, conversionEntryId: conversion.entryId,
      reason: `Operation completed with ${doneQty} units.` } });
  await backflushOperation(tx, orgId, actorId, workOrderId, operationId, "finish");
  await finishInspectionRework(tx,orgId,actorId,operationId);
  return after;
}
