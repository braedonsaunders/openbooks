import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, cmp, fromUnits, isZero, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import { assertItemsActive } from "../inventory/item-active.ts";
import { assertStockLocationAdmitsSubsidiary, resolveProfile } from "../inventory/profile-policy.ts";
import { assertInventoryAccountsPostable, stockLocationDim, type JournalLineInput } from "../inventory/journal.ts";
import { addLayerAtCost } from "../inventory/cost-layers.ts";
import { InventoryError, type Runner } from "../inventory/contracts.ts";
import { ensureLot, ensureSerial, validateTrackingSelection } from "../inventory/tracking.ts";
import { assertInventoryDate, lockInventoryPosition, periodForDate, primaryBookId, subsidiaryCurrency } from "../inventory/position.ts";
import { extendCost, unitCostPerQuantity } from "../inventory/costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, decimalValue } from "./master-support.ts";
import { getManufacturingPolicies } from "./policies.ts";
import { bomRequiredQuantity } from "../inventory/bom-scrap.ts";
import { manufacturingControlAccount, postManufacturingEntry } from "./journal.ts";
import { restoreIssueLayers, reverseInventoryJournal, type ReverseInventoryInput, type ReverseInventoryResult, type ReversibleMovement } from "../inventory/reversal.ts";

type Order = {
  id: string; number: string; produced_item_id: string; status: string; hold_reason: string | null;
  quantity_ordered: string; quantity_completed: string; subsidiary_id: string | null;
  receipt_location_id: string | null; issue_location_id: string | null;
  bom_revision: string | null; routing_version: number | null; standard_cost_snapshot: string | null;
  planned_start: string | null; short_close_reason: string | null;
};
type Material = {
  id: string; component_item_id: string; component_code: string | null; component_name: string; required_qty: string;
  issued_qty: string; backflush_qty: string; operation_seq: number | null; waived_at: Date | null;
  quantity_per: string; scrap_pct: string;
};
type ReceiptSelection = { itemId?: string; quantity: string; lotNumber?: string; expiresOn?: string | null; serialNumber?: string };
export interface CompleteWorkOrderInput {
  quantity: string; receiptLocationId?: string | null; lots?: ReceiptSelection[];
  byproductValues?: Array<{ itemId: string; nrvUnit: string; reason: string }>;
}
type ReceiptPiece = { quantity: string; lotId: string | null; serialId: string | null; serialNumber: string | null };
type Byproduct = { item_id: string; code: string | null; name: string; quantity_per: string; default_rate: string | null };

function refuse(message: string, code: string, remedy: string, status = 422): never {
  throw new ManufacturingError(message, { status, code, remedy });
}
function rowOrNotFound<T>(rows: T[]): T {
  if (!rows[0]) throw new ManufacturingNotFoundError();
  return rows[0];
}
function materialLabel(material: Material): string {
  return material.component_code?.trim() || material.component_name;
}
async function loadItemLabels(tx: SqlExecutor, orgId: string, itemIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute<{ id: string; code: string | null; name: string }>(sql`
    select id, code, name from items where org_id=${orgId}
      and id in (${sql.join(ids.map((itemId) => sql`${itemId}::uuid`), sql`,`)}) order by id`)).rows;
  if (rows.length !== ids.length) throw new ManufacturingNotFoundError();
  return new Map(rows.map((row) => [row.id, row.code?.trim() || row.name]));
}
function evidence(order: Order) {
  if (!order.bom_revision || order.routing_version === null) {
    refuse("Work order " + order.number + " has no released BOM and routing evidence.", "work_order_snapshot_missing", "Release the work order from an active routing and BOM.", 409);
  }
  return { workOrderNumber: order.number, bomRevision: order.bom_revision, routingVersion: String(order.routing_version) };
}
async function loadOrder(tx: SqlExecutor, orgId: string, id: string, lock = false): Promise<Order> {
  return rowOrNotFound((await tx.execute<Order>(sql`
    select id, number, produced_item_id, status, hold_reason, quantity_ordered::text, quantity_completed::text,
           subsidiary_id, receipt_location_id, issue_location_id, bom_revision, routing_version,
           standard_cost_snapshot::text, planned_start::text, short_close_reason
      from mfg_work_orders where org_id=${orgId} and id=${id} ${lock ? sql`for update` : sql``}`)).rows);
}
function refuseIfHeld(order: Order): void {
  if (order.status === "on_hold") {
    refuse("Work order " + order.number + " is on hold for " + (order.hold_reason?.trim() || "no reason recorded") + ".", "work_order_on_hold", "Resume the work order before posting completion.", 409);
  }
}
async function wipBalance(tx: SqlExecutor, orgId: string, order: Order, accountId: string): Promise<string> {
  const row = (await tx.execute<{ balance: string }>(sql`
    select coalesce(sum(line.amount), 0)::text as balance
      from journal_lines line join journal_entries entry
        on entry.org_id=line.org_id and entry.id=line.entry_id
     where line.org_id=${orgId} and line.account_id=${accountId}
       and entry.origin='manufacturing' and entry.custom->>'work_order_number'=${order.number}
       and entry.status in ('posted','reversed')`)).rows[0];
  return row?.balance ?? "0.0000";
}
function ratioAmount(value: string, numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new Error("positive remaining work-order quantity required");
  return fromUnits(roundDiv(toUnits(value) * numerator, denominator));
}
function overTolerance(completed: string, ordered: string, tolerance: string): boolean {
  return toUnits(completed) * 1_000_000n > toUnits(ordered) * (1_000_000n + toUnits(tolerance));
}
function withinTolerance(completed: string, ordered: string, tolerance: string): boolean {
  const difference = toUnits(completed) - toUnits(ordered);
  const absolute = difference < 0n ? -difference : difference;
  return absolute * 1_000_000n <= toUnits(ordered) * toUnits(tolerance);
}
async function lockPositions(tx: SqlExecutor, itemIds: string[], locationId: string): Promise<void> {
  for (const itemId of [...new Set(itemIds)].sort()) await lockInventoryPosition(tx as Runner, itemId, locationId);
}
async function loadMaterials(tx: SqlExecutor, orgId: string, orderId: string, lock = false): Promise<Material[]> {
  return (await tx.execute<Material>(sql`
    select material.id, material.component_item_id, item.name as component_name,
           item.code as component_code, material.required_qty::text, material.issued_qty::text, material.backflush_qty::text,
           material.operation_seq, material.waived_at,
           material.quantity_per::text as quantity_per,
           material.scrap_pct::text as scrap_pct
      from mfg_wo_materials material join items item
        on item.org_id=material.org_id and item.id=material.component_item_id
     where material.org_id=${orgId} and material.work_order_id=${orderId}
     order by material.id ${lock ? sql`for update of material` : sql``}`)).rows;
}
async function loadByproducts(tx: SqlExecutor, orgId: string, order: Order): Promise<Byproduct[]> {
  return (await tx.execute<Byproduct>(sql`
    select item.id as item_id, item.code, item.name, byproduct.quantity_per::text, item.default_rate::text
      from mfg_wo_byproducts byproduct join items item
        on item.org_id=byproduct.org_id and item.id=byproduct.item_id
     where byproduct.org_id=${orgId} and byproduct.work_order_id=${order.id}
     order by byproduct.item_id`)).rows;
}
async function materialUsageVariance(
  tx: SqlExecutor, orgId: string, order: Order, materials: Material[], completedQuantity: string,
): Promise<{ cumulative: string; delta: string; byComponent: Array<{ itemId: string; name: string; cumulative: string; delta: string }> }> {
  const issueCosts = (await tx.execute<{ item_id: string; quantity: string; unit_value: string; unit_quantity: string }>(sql`
    select movement.item_id, sum(-movement.quantity)::text as quantity,
           sum(case when movement.kind='assembly_consume' then -movement.total_value else 0 end)::text as unit_value,
           sum(case when movement.kind='assembly_consume' then -movement.quantity else 0 end)::text as unit_quantity
      from inventory_movements movement
      left join inventory_movements source on source.org_id=movement.org_id and source.id=movement.reverses_movement_id
      left join journal_entries source_entry on source_entry.org_id=source.org_id and source_entry.id=source.journal_entry_id
      left join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
     where movement.org_id=${orgId} and (
       (movement.kind='assembly_consume' and entry.origin='manufacturing' and entry.custom->>'work_order_number'=${order.number})
       or (movement.kind='return' and source.kind='assembly_consume' and source_entry.origin='manufacturing'
         and source_entry.custom->>'work_order_number'=${order.number})
     )
     group by movement.item_id`)).rows;
  const issues = new Map(issueCosts.map((issue) => [issue.item_id, issue]));
  const priorByComponent = new Map<string, string>();
  const priorRows = (await tx.execute<{ deltas: Record<string, string> | null }>(sql`
    select custom->'material_usage_variance_delta_by_component' as deltas
      from journal_entries where org_id=${orgId} and origin='manufacturing'
        and custom->>'work_order_number'=${order.number}
        -- Live entries only: only unreversed posted material-usage variance deltas contribute to cumulative variance.
        and custom ? 'material_usage_variance_delta_by_component' and status='posted'`)).rows;
  for (const row of priorRows) {
    if (!row.deltas || typeof row.deltas !== "object" || Array.isArray(row.deltas)) continue;
    for (const [itemId, amount] of Object.entries(row.deltas)) {
      priorByComponent.set(itemId, add(priorByComponent.get(itemId) ?? "0", String(amount)));
    }
  }
  const byComponent: Array<{ itemId: string; name: string; cumulative: string; delta: string }> = [];
  for (const componentId of new Set(materials.map((material) => material.component_item_id))) {
    const issue = issues.get(componentId);
    if (!issue || cmp(issue.unit_quantity, "0") <= 0) continue;
    const unitCost = unitCostPerQuantity(issue.unit_value, issue.unit_quantity);
    if (!unitCost) continue;
    let allowed = "0.0000";
    for (const material of materials.filter((line) => line.component_item_id === componentId)) {
      allowed = add(allowed, bomRequiredQuantity(completedQuantity, material.quantity_per, material.scrap_pct).quantity);
    }
    const cumulative = add(extendCost(issue.quantity, unitCost), neg(extendCost(allowed, unitCost)));
    const name = materialLabel(materials.find((material) => material.component_item_id === componentId)!);
    byComponent.push({ itemId: componentId, name, cumulative,
      delta: add(cumulative, neg(priorByComponent.get(componentId) ?? "0")) });
  }
  return { cumulative: sum(byComponent.map((component) => component.cumulative)),
    delta: sum(byComponent.map((component) => component.delta)), byComponent };
}
async function receiptPieces(
  tx: SqlExecutor, orgId: string, actorId: string, itemId: string, quantity: string, locationId: string,
  itemName: string, profile: Awaited<ReturnType<typeof resolveProfile>>, selections: ReceiptSelection[],
): Promise<ReceiptPiece[]> {
  const chosen = selections.filter((entry) => (entry.itemId ?? itemId) === itemId);
  if (profile.tracking === "none") {
    if (chosen.length) refuse("Untracked item " + itemName + " cannot receive lot or serial selections.", "tracking_selection_not_allowed", "Remove the tracking selection from the receipt.");
    return [{ quantity, lotId: null, serialId: null, serialNumber: null }];
  }
  if (!chosen.length) {
    refuse(profile.tracking + "-tracked finished good " + itemName + " requires " + profile.tracking + " evidence for the receipt.", "receipt_tracking_required", "Select or create a " + profile.tracking + " for the receipt.");
  }
  const pieces: ReceiptPiece[] = [];
  let total = "0.0000";
  for (const selection of chosen) {
    const q = decimalValue(selection.quantity, "receipt lot quantity", "Enter a positive exact quantity.");
    if (cmp(q, "0") <= 0) refuse("Receipt lot quantity must be positive.", "invalid_receipt_quantity", "Enter a positive exact quantity.");
    let lotId: string | null = null;
    let serialId: string | null = null;
    if (profile.tracking === "lot") {
      if (!selection.lotNumber?.trim()) refuse("Lot-tracked item " + itemName + " requires a lot number.", "receipt_lot_required", "Enter a lot number for the receipt.");
      lotId = await ensureLot(orgId, itemId, selection.lotNumber, selection.expiresOn ?? null, actorId);
    } else {
      if (cmp(q, "1") !== 0 || !selection.serialNumber?.trim()) refuse("Serial-tracked item " + itemName + " requires one serial number per unit.", "receipt_serial_required", "Enter a serial number for each finished unit.");
      serialId = await ensureSerial(orgId, itemId, selection.serialNumber, locationId, actorId);
    }
    await validateTrackingSelection(tx as Runner, orgId, itemId, locationId, profile,
      { quantity: q, lotId, serialId }, "receipt");
    pieces.push({ quantity: q, lotId, serialId, serialNumber: serialId ? selection.serialNumber!.trim() : null });
    total = add(total, q);
  }
  if (cmp(total, quantity) !== 0) {
    refuse("Tracking selections total " + total + ", but the receipt quantity is " + quantity + ".", "receipt_tracking_quantity_mismatch", "Make the lot or serial quantities equal the finished quantity.");
  }
  return pieces;
}
function splitValue(totalValue: string, pieces: ReceiptPiece[]): string[] {
  const totalQuantity = toUnits(sum(pieces.map((piece) => piece.quantity)));
  let assigned = 0n;
  return pieces.map((piece, index) => {
    const value = index === pieces.length - 1
      ? toUnits(totalValue) - assigned
      : roundDiv(toUnits(totalValue) * toUnits(piece.quantity), totalQuantity);
    assigned += value;
    return fromUnits(value);
  });
}
async function postReceiptLayer(
  tx: SqlExecutor, orgId: string, actorId: string, order: Order, itemId: string,
  locationId: string, date: string, entryId: string, pieces: ReceiptPiece[], values: string[],
  costingMethod: "fifo" | "moving_average" | "standard", memo: string,
): Promise<void> {
  for (const [index, piece] of pieces.entries()) {
    const value = values[index]!;
    const unitCost = unitCostPerQuantity(value, piece.quantity) ?? "0.0000";
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${order.subsidiary_id}, ${itemId}, 'assembly_build', ${date}, ${locationId},
        ${piece.lotId}, ${piece.serialId}, ${piece.quantity}, ${unitCost}, ${value}, ${entryId},
        'posted', ${memo}, ${actorId}, ${actorId}) returning id`);
    const movementId = rowOrNotFound(inserted.rows).id;
    await addLayerAtCost(tx as Runner, orgId, order.subsidiary_id!, itemId, locationId,
      piece.quantity, value, costingMethod, movementId, date, actorId, unitCost);
    await auditChange(tx, { orgId, actorId, table: "inventory_movements", rowId: movementId,
      action: "insert", before: null, after: { itemId, quantity: piece.quantity, totalValue: value,
        journalEntryId: entryId, kind: "assembly_build", lotId: piece.lotId, serialId: piece.serialId, memo } });
    if (piece.serialId) {
      const serial = await tx.execute<{ id: string }>(sql`
        update serials set status='in_stock', current_stock_location_id=${locationId}, updated_at=now(), updated_by=${actorId}
         where org_id=${orgId} and id=${piece.serialId} and status='registered' returning id`);
      if (serial.rows.length !== 1) throw new ManufacturingError("Serial " + (piece.serialNumber ?? "evidence") + " changed before receipt.", { code: "receipt_serial_changed", remedy: "Review the serial history and retry with an unused serial." });
    }
  }
}

export async function completeWorkOrder(
  tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string, input: CompleteWorkOrderInput,
): Promise<{ entryId: string; quantityCompleted: string; relievedWip: string; value: string }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const preview = await loadOrder(tx, orgId, workOrderId);
  const locationId = input.receiptLocationId ?? preview.receipt_location_id;
  if (!locationId) {
    refuse("Work order " + preview.number + " has no receipt location.", "work_order_receipt_location_required", "Choose a receipt location on the work order or supply one for this completion.");
  }
  const byproducts = await loadByproducts(tx, orgId, preview);
  const itemIds = [preview.produced_item_id, ...byproducts.map((row) => row.item_id)];
  await lockPositions(tx, itemIds, locationId);
  const order = await loadOrder(tx, orgId, workOrderId, true);
  refuseIfHeld(order);
  if (order.status !== "released" && order.status !== "in_progress") {
    refuse("Work order " + order.number + " cannot receive finished goods from " + order.status + ".", "invalid_work_order_transition", "Release the work order before recording a completion.", 409);
  }
  const q = decimalValue(input.quantity, "completion quantity", "Enter a positive exact quantity with no more than four decimal places.");
  if (cmp(q, "0") <= 0) refuse("Completion quantity must be positive.", "invalid_completion_quantity", "Enter a positive exact quantity.");
  const completed = add(order.quantity_completed, q);
  const policies = await getManufacturingPolicies(tx, orgId);
  if (overTolerance(completed, order.quantity_ordered, policies.completionTolerancePct)) {
    refuse("Work order " + order.number + " would exceed its " + policies.completionTolerancePct + "% completion tolerance.", "completion_tolerance_exceeded", "Revise the order quantity.");
  }
  const ev = evidence(order);
  const ctx = await loadSubsidiaryContext(tx, orgId);
  if (!order.subsidiary_id) refuse("Work order " + order.number + " has no subsidiary.", "work_order_subsidiary_required", "Choose an operating subsidiary before completing the work order.");
  await assertStockLocationAdmitsSubsidiary(tx as Runner, orgId, ctx, locationId, order.subsidiary_id, "inbound");
  await assertItemsActive(tx as Runner, orgId, itemIds, {
    inactiveRemedy: "reactivate the item before receiving manufacturing output",
    outsideOrganization: "The work order output references an item outside this organization.",
  });
  const itemLabels = await loadItemLabels(tx, orgId, itemIds);
  const producedProfile = await resolveProfile(orgId, order.produced_item_id, tx as Runner, true);
  const materials = await loadMaterials(tx, orgId, order.id, true);
  const wipId = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgWip");
  const usage = producedProfile.costingMethod === "standard"
    ? await materialUsageVariance(tx, orgId, order, materials, completed)
    : { cumulative: "0.0000", delta: "0.0000", byComponent: [] };
  const hasUsageVariance = usage.byComponent.some((component) => !isZero(component.delta));
  const usageVarianceId = hasUsageVariance
    ? await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgMaterialUsageVariance")
    : null;
  const balance = await wipBalance(tx, orgId, order, wipId);
  if (cmp(balance, "0") < 0) {
    refuse("Work order " + order.number + " has a credit balance in Manufacturing WIP.", "negative_work_order_wip", "Review the work order's manufacturing journal entries before completing it.");
  }
  const remainingQuantity = add(order.quantity_ordered, neg(order.quantity_completed));
  const relievedWip = cmp(completed, order.quantity_ordered) >= 0
    ? balance : ratioAmount(balance, toUnits(q), toUnits(remainingQuantity));
  const selections = input.lots ?? [];
  const date = await businessToday(orgId);
  const bookId = await primaryBookId(orgId, tx as Runner);
  const periodId = await periodForDate(orgId, date, tx as Runner);
  if (!periodId) throw new ManufacturingError("No accounting period covers " + date + ".", { code: "posting_period_missing", remedy: "Open an accounting period for the completion date." });
  const currency = await subsidiaryCurrency(orgId, order.subsidiary_id, tx as Runner);
  const locationDimension = await stockLocationDim(tx, orgId, locationId, null);
  const lines: JournalLineInput[] = [];
  const byproductReceipts: Array<{ row: Byproduct; quantity: string; unit: string; value: string; profile: Awaited<ReturnType<typeof resolveProfile>>; pieces: ReceiptPiece[] }> = [];
  let byproductValue = "0.0000";
  for (const row of byproducts) {
    const quantity = bomRequiredQuantity(q, row.quantity_per, "0").quantity;
    if (cmp(quantity, "0") <= 0) continue;
    const manual = input.byproductValues?.find((value) => value.itemId === row.item_id);
    const nrvUnit = row.default_rate ?? manual?.nrvUnit ?? null;
    if (!nrvUnit) refuse("By-product " + (row.code?.trim() || row.name) + " has no NRV value.", "byproduct_nrv_missing", "Set a default rate on the by-product item or provide a manual NRV with a reason.");
    if (row.default_rate === null && !manual?.reason?.trim()) {
      refuse("By-product " + (row.code?.trim() || row.name) + " needs a reason for its manual NRV.", "byproduct_nrv_reason_required", "Enter the reason for the manual NRV.");
    }
    const normalizedNrv = decimalValue(nrvUnit, "by-product NRV unit", "Enter an exact NRV unit value.");
    if (cmp(normalizedNrv, "0") < 0) refuse("By-product " + (row.code?.trim() || row.name) + " has a negative NRV unit value.", "byproduct_nrv_negative", "Enter a non-negative NRV unit value.");
    const value = extendCost(quantity, normalizedNrv);
    byproductValue = add(byproductValue, value);
    const profile = await resolveProfile(orgId, row.item_id, tx as Runner, true);
    byproductReceipts.push({ row, quantity, unit: normalizedNrv, value, profile, pieces: [] });
    lines.push({ accountId: profile.assetAccountId, amount: value, locationId: locationDimension,
      memo: "Work order " + order.number + " by-product " + (row.code?.trim() || row.name) + " at NRV" });
  }
  const mainActualValue = add(relievedWip, neg(byproductValue));
  if (cmp(mainActualValue, "0") < 0) {
    refuse("By-product NRV exceeds the WIP relief for work order " + order.number + ".", "byproduct_nrv_exceeds_wip", "Reduce the by-product NRV or complete more output before receiving it.");
  }
  let finishedValue = mainActualValue;
  if (producedProfile.costingMethod === "standard") {
    if (!order.standard_cost_snapshot) {
      refuse("Work order " + order.number + " has no standard cost snapshot.", "standard_cost_snapshot_missing", "Release a new work order after configuring the produced item's standard cost.", 409);
    }
    finishedValue = extendCost(q, order.standard_cost_snapshot);
  }
  const validReceiptItems = new Set([order.produced_item_id, ...byproductReceipts.map((receipt) => receipt.row.item_id)]);
  if (selections.some((selection) => selection.itemId && !validReceiptItems.has(selection.itemId))) {
    refuse("A tracking selection references an item not received by this completion.", "receipt_tracking_item_invalid", "Choose the produced item or a by-product on this work order.");
  }
  if (input.byproductValues?.some((value) => !byproducts.some((row) => row.item_id === value.itemId))) {
    refuse("A manual NRV references an item that is not a by-product on this order.", "byproduct_nrv_item_invalid", "Provide NRV values only for this order's by-products.");
  }
  const itemVariance = add(add(relievedWip, neg(byproductValue)), neg(finishedValue));
  const finalItemVariance = add(itemVariance, neg(usage.delta));
  const varianceLines: JournalLineInput[] = [];
  for (const component of usage.byComponent) {
    if (isZero(component.delta)) continue;
    varianceLines.push({ accountId: usageVarianceId!, amount: component.delta,
      locationId: locationDimension, memo: "Work order " + order.number + " material usage variance: " + component.name });
  }
  if (!isZero(finalItemVariance)) {
    if (!producedProfile.varianceAccountId) {
      refuse("Finished good " + itemLabels.get(order.produced_item_id)! + " has a production variance but no variance account.", "finished_good_variance_account_missing", "Configure the produced item's variance account in inventory costing setup.");
    }
    varianceLines.push({ accountId: producedProfile.varianceAccountId, amount: finalItemVariance,
      locationId: locationDimension, memo: "Work order " + order.number + " production variance" });
  }
  if (!isZero(finishedValue)) lines.push({ accountId: producedProfile.assetAccountId, amount: finishedValue,
    locationId: locationDimension, memo: "Work order " + order.number + " finished goods" });
  if (!isZero(relievedWip)) lines.push({ accountId: wipId, amount: neg(relievedWip),
    locationId: locationDimension, memo: "Work order " + order.number + " WIP relief" });
  lines.push(...varianceLines);
  if (!isZero(sum(lines.map((line) => line.amount)))) {
    throw new ManufacturingError("The completion journal does not balance.", { code: "completion_unbalanced", remedy: "Review the work order's cost layers and journal evidence before retrying." });
  }
  await assertInventoryAccountsPostable(tx as Runner, orgId, lines.map((line) => line.accountId));
  const piecesByItem = await receiptPieces(tx, orgId, actorId, order.produced_item_id, q, locationId,
    itemLabels.get(order.produced_item_id)!, producedProfile, selections);
  for (const receipt of byproductReceipts) {
    receipt.pieces = await receiptPieces(tx, orgId, actorId, receipt.row.item_id, receipt.quantity,
      locationId, receipt.row.code?.trim() || receipt.row.name, receipt.profile, selections);
  }
  const entryId = await postManufacturingEntry(tx as Runner, {
    orgId, bookId, subsidiaryId: order.subsidiary_id, actorId, currency, periodId, date,
    entryNumber: "MFG-COMP-" + date + "-" + randomUUID().slice(0, 12),
    memo: "Finished goods completion for work order " + order.number, lines,
    custom: { ...ev, completion_quantity: q, completed_quantity: completed,
      material_usage_variance_cumulative: usage.cumulative,
      material_usage_variance_delta_by_component: Object.fromEntries(usage.byComponent.map((component) => [component.itemId, component.delta])),
      byproductNrv: byproductReceipts.map(({ row, unit, value }) => ({ itemId: row.item_id, nrvUnit: unit, value,
        reason: row.default_rate === null ? input.byproductValues?.find((v) => v.itemId === row.item_id)?.reason?.trim() : null })) },
  });
  await postReceiptLayer(tx, orgId, actorId, order, order.produced_item_id, locationId, date, entryId,
    piecesByItem, splitValue(finishedValue, piecesByItem), producedProfile.costingMethod, "Work order " + order.number + " completion");
  for (const receipt of byproductReceipts) {
    await postReceiptLayer(tx, orgId, actorId, order, receipt.row.item_id, locationId, date, entryId,
      receipt.pieces, splitValue(receipt.value, receipt.pieces), receipt.profile.costingMethod,
      "Work order " + order.number + " by-product receipt");
    if (receipt.row.default_rate === null) {
      await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: order.id, action: "update",
        before: { byproductItemId: receipt.row.item_id },
        after: { byproductItemId: receipt.row.item_id, nrvUnit: receipt.unit,
          reason: input.byproductValues?.find((v) => v.itemId === receipt.row.item_id)?.reason?.trim() } });
    }
  }
  const update = await tx.execute<{ id: string }>(sql`
    update mfg_work_orders set quantity_completed=${completed}, status='in_progress',
      started_at=coalesce(started_at, now()), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${order.id} and status in ('released','in_progress')
       and quantity_completed=${order.quantity_completed} returning id`);
  if (update.rows.length !== 1) refuse("Work order " + order.number + " changed while completion was posting.", "work_order_changed", "Reload the work order and retry.", 409);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: order.id, action: "update",
    before: order, after: { ...order, quantity_completed: completed, status: "in_progress",
      lastCompletionEntryId: entryId, reason: "Finished goods were received." } });
  return { entryId, quantityCompleted: completed, relievedWip, value: finishedValue };
}

export async function waiveMaterial(
  tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string, materialId: string, reason: string,
): Promise<{ id: string; waivedAt: Date }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const order = await loadOrder(tx, orgId, workOrderId, true);
  refuseIfHeld(order);
  if (order.status !== "released" && order.status !== "in_progress") {
    refuse("Materials on work order " + order.number + " cannot be waived from " + order.status + ".", "invalid_work_order_transition", "Waive material lines before marking the work order done.", 409);
  }
  const cleanReason = reason.trim();
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    refuse("A material waiver requires a reason between 5 and 500 characters.", "material_waiver_reason_required", "Enter why the planned material is being waived.");
  }
  const material = (await tx.execute<{ id: string; waived_at: Date | null; waive_reason: string | null }>(sql`
    select id, waived_at, waive_reason from mfg_wo_materials
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${materialId} for update`)).rows[0];
  if (!material) throw new ManufacturingNotFoundError();
  if (material.waived_at) {
    if (material.waive_reason !== cleanReason) {
      refuse("This material already has a different waiver reason.", "material_already_waived", "Keep the original waiver evidence; a second waiver is not allowed.", 409);
    }
    return { id: material.id, waivedAt: material.waived_at };
  }
  const updated = await tx.execute<{ id: string; waived_at: Date }>(sql`
    update mfg_wo_materials set waived_at=now(), waived_by=${actorId}, waive_reason=${cleanReason},
      updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and work_order_id=${workOrderId} and id=${materialId} and waived_at is null
     returning id, waived_at`);
  const after = rowOrNotFound(updated.rows);
  await auditChange(tx, { orgId, actorId, table: "mfg_wo_materials", rowId: material.id, action: "update",
    before: { waivedAt: null, waivedBy: null, waiveReason: null },
    after: { waivedAt: after.waived_at, waivedBy: actorId, waiveReason: cleanReason } });
  return { id: after.id, waivedAt: after.waived_at };
}

export async function markWorkOrderDone(
  tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string,
  input: { shortCloseReason?: string | null } = {},
): Promise<{ id: string; status: "done"; shortCloseReason: string | null }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const preview = await loadOrder(tx, orgId, workOrderId);
  if (preview.receipt_location_id) await lockPositions(tx, [preview.produced_item_id], preview.receipt_location_id);
  const order = await loadOrder(tx, orgId, workOrderId, true);
  if (order.status === "done") return { id: order.id, status: "done", shortCloseReason: order.short_close_reason };
  refuseIfHeld(order);
  if (order.status !== "in_progress" && order.status !== "released") {
    refuse("Work order " + order.number + " cannot be marked done from " + order.status + ".", "invalid_work_order_transition", "Complete the released work order before marking it done.", 409);
  }
  const policies = await getManufacturingPolicies(tx, orgId);
  if (!withinTolerance(order.quantity_completed, order.quantity_ordered, policies.completionTolerancePct)) {
    refuse("Work order " + order.number + " completed " + order.quantity_completed + " of " + order.quantity_ordered + ", outside the " + policies.completionTolerancePct + "% completion tolerance.", "completion_tolerance_not_met", "Complete the remaining quantity or revise the order quantity.");
  }
  const shortCloseReason = input.shortCloseReason?.trim() || null;
  const short = cmp(order.quantity_completed, order.quantity_ordered) < 0;
  if (short && !shortCloseReason) {
    refuse("Work order " + order.number + " is being completed below its ordered quantity.", "short_close_reason_required", "Enter a short-close reason before marking the work order done.");
  }
  const operations = (await tx.execute<{ sequence: number }>(sql`
    select operation.sequence from mfg_wo_operations operation
     where operation.org_id=${orgId} and operation.work_order_id=${order.id}
       and operation.quality_gate='measure' and operation.measured_qty is null
     order by operation.sequence`)).rows;
  if (operations.length) {
    refuse("Work order " + order.number + " has measure operation " + operations.map((row) => row.sequence).join(", ") + " without a measured quantity.", "measure_quantity_missing", "Record the measured quantity for each named operation.");
  }
  const materials = await loadMaterials(tx, orgId, order.id, true);
  const shortExplicit = materials.filter((line) => line.operation_seq === null && line.waived_at === null
    && cmp(add(line.issued_qty, line.backflush_qty), line.required_qty) < 0);
  if (shortExplicit.length) {
    refuse("Work order " + order.number + " has under-issued explicit material " + shortExplicit.map((line) => line.component_name).join(", ") + ".", "explicit_material_underissued", "Issue the named material or waive its line with a reason.");
  }
  const openChildren = (await tx.execute<{ number: string }>(sql`
    with recursive children as (
      select id, number, status from mfg_work_orders where org_id=${orgId} and parent_wo_id=${order.id}
      union all
      select child.id, child.number, child.status from mfg_work_orders child
        join children parent on child.parent_wo_id=parent.id where child.org_id=${orgId}
    )
    select number from children where status<>'done' order by number`)).rows;
  if (openChildren.length) {
    refuse("Work order " + order.number + " has child work orders not done: " + openChildren.map((row) => row.number).join(", ") + ".", "child_work_order_open", "Complete each named child work order before marking the parent done.");
  }
  const wipId = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgWip");
  const residual = await wipBalance(tx, orgId, order, wipId);
  if (cmp(residual, "0") < 0) {
    refuse("Work order " + order.number + " has a credit balance in Manufacturing WIP.", "negative_work_order_wip", "Review the work order's manufacturing journal entries before marking it done.");
  }
  if (!isZero(residual)) {
    const profile = await resolveProfile(orgId, order.produced_item_id, tx as Runner, true);
    if (!profile.varianceAccountId) {
      const itemLabels = await loadItemLabels(tx, orgId, [order.produced_item_id]);
      refuse("Finished good " + itemLabels.get(order.produced_item_id)! + " has short-close WIP but no variance account.", "short_close_variance_account_missing", "Configure the produced item's variance account in inventory costing setup.");
    }
    const date = await businessToday(orgId);
    const bookId = await primaryBookId(orgId, tx as Runner);
    const periodId = await periodForDate(orgId, date, tx as Runner);
    if (!periodId) throw new ManufacturingError("No accounting period covers " + date + ".", { code: "posting_period_missing", remedy: "Open an accounting period for the completion date." });
    const subsidiaryId = order.subsidiary_id;
    if (!subsidiaryId) refuse("Work order " + order.number + " has no subsidiary.", "work_order_subsidiary_required", "Choose an operating subsidiary before completing the work order.");
    const postingLines: JournalLineInput[] = [
      { accountId: profile.varianceAccountId, amount: residual, memo: "Short-close variance" },
      { accountId: wipId, amount: neg(residual), memo: "Final WIP relief" },
    ];
    await assertInventoryAccountsPostable(tx as Runner, orgId, postingLines.map((line) => line.accountId));
    await postManufacturingEntry(tx as Runner, {
      orgId, bookId, subsidiaryId, actorId, currency: await subsidiaryCurrency(orgId, subsidiaryId, tx as Runner),
      periodId, date, entryNumber: "MFG-SHORT-" + date + "-" + randomUUID().slice(0, 12),
      memo: "Short-close WIP variance for work order " + order.number, lines: postingLines,
      custom: { ...evidence(order), shortCloseReason: shortCloseReason ?? "Completed within order tolerance." },
    });
  }
  const updated = await tx.execute<{ id: string }>(sql`
    update mfg_work_orders set status='done', short_close_reason=${short ? shortCloseReason : null},
      completed_at=now(), updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${order.id} and status=${order.status}
       and quantity_completed=${order.quantity_completed} returning id`);
  if (updated.rows.length !== 1) {
    refuse("Work order " + order.number + " changed while it was being marked done.", "work_order_changed", "Reload the work order and retry.", 409);
  }
  await auditChange(tx, { orgId, actorId, table: "mfg_work_orders", rowId: order.id, action: "update",
    before: order, after: { ...order, status: "done", short_close_reason: short ? shortCloseReason : null,
      reason: shortCloseReason ?? "Completion requirements were met." } });
  return { id: order.id, status: "done", shortCloseReason: short ? shortCloseReason : null };
}

async function lockMovementPositions(tx: SqlExecutor, movements: ReversibleMovement[]): Promise<void> {
  const positions = [...new Set(movements.map((movement) => movement.item_id + ":" + movement.stock_location_id))].sort();
  for (const position of positions) {
    const split = position.indexOf(":");
    await lockInventoryPosition(tx as Runner, position.slice(0, split), position.slice(split + 1));
  }
}

export async function reverseMaterialIssue(
  orgId: string, actorId: string, input: ReverseInventoryInput,
): Promise<ReverseInventoryResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError("reversal reason must be between 5 and 500 characters");
  }
  assertInventoryDate(input.reversalDate, "reversal date");
  return db.transaction(async (tx) => {
    await assertManufacturingFeature(tx, orgId, "manufacturing");
    const peek = (await tx.execute<ReversibleMovement & { entry_origin: string | null; work_order_number: string | null }>(sql`
      select movement.id, movement.org_id, movement.subsidiary_id, movement.item_id, movement.kind,
             movement.moved_at::text, movement.stock_location_id, movement.lot_id, movement.serial_id,
             movement.quantity, movement.unit_cost, movement.total_value, movement.journal_entry_id,
             movement.paired_movement_id, movement.status, entry.origin as entry_origin,
             entry.custom->>'work_order_number' as work_order_number
        from inventory_movements movement left join journal_entries entry
          on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
       where movement.org_id=${orgId} and movement.id=${input.movementId}`)).rows[0];
    if (!peek) throw new ManufacturingNotFoundError();
    if (peek.entry_origin !== "manufacturing") throw new InventoryError("The movement is not a manufacturing work-order movement.");
    if (peek.kind === "assembly_build") throw new InventoryError("work-order completion receipts cannot be reversed yet");
    if (peek.kind !== "assembly_consume" || !peek.journal_entry_id || !peek.work_order_number) {
      throw new InventoryError("Only a posted work-order material issue or backflush can be reversed.");
    }
    const sourceRows = (await tx.execute<ReversibleMovement>(sql`
      select id, org_id, subsidiary_id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id, paired_movement_id, status
        from inventory_movements where org_id=${orgId} and journal_entry_id=${peek.journal_entry_id}
          and kind='assembly_consume' order by item_id, stock_location_id, id`)).rows;
    if (!sourceRows.length) throw new InventoryError("The work-order issue has no consume movements.");
    await lockMovementPositions(tx, sourceRows);
    const order = (await tx.execute<Order>(sql`
      select id, number, produced_item_id, status, hold_reason, quantity_ordered::text, quantity_completed::text,
             subsidiary_id, receipt_location_id, issue_location_id, bom_revision, routing_version,
             standard_cost_snapshot::text, planned_start::text, short_close_reason
        from mfg_work_orders where org_id=${orgId} and number=${peek.work_order_number} for update`)).rows[0];
    if (!order) throw new ManufacturingNotFoundError();
    const prior = (await tx.execute<{ id: string }>(sql`
      select id from journal_entries where org_id=${orgId} and reverses_entry_id=${peek.journal_entry_id}
        and status in ('posted','reversed') order by id limit 1`)).rows[0];
    if (prior) {
      const reversalMovements = (await tx.execute<{ id: string }>(sql`
        select id from inventory_movements where org_id=${orgId}
          and reverses_movement_id in (${sql.join(sourceRows.map((row) => sql`${row.id}`), sql`,`)})
        order by id`)).rows;
      if (reversalMovements.length !== sourceRows.length) {
        throw new InventoryError("The work-order issue reversal is incomplete; contact an administrator before retrying.");
      }
      return { movementIds: reversalMovements.map((row) => row.id), entryId: prior.id, alreadyReversed: true };
    }
    if (order.status === "done" || order.status === "closed") {
      refuse("Material issue for work order " + order.number + " cannot be reversed after it is " + order.status + ".", "issue_reversal_after_completion", "Use a new work order for any additional material movement.", 409);
    }
    const lockedSources = (await tx.execute<ReversibleMovement>(sql`
      select movement.id, movement.org_id, movement.subsidiary_id, movement.item_id, movement.kind,
             movement.moved_at::text, movement.stock_location_id, movement.lot_id,
             movement.serial_id, serial.serial_number, movement.quantity, movement.unit_cost,
             movement.total_value, movement.journal_entry_id, movement.paired_movement_id, movement.status
        from inventory_movements movement left join serials serial
          on serial.org_id=movement.org_id and serial.id=movement.serial_id
       where movement.org_id=${orgId} and movement.journal_entry_id=${peek.journal_entry_id}
          and movement.kind='assembly_consume' order by movement.id for update of movement`)).rows;
    if (lockedSources.length !== sourceRows.length || lockedSources.some((row) => row.status !== "posted")) {
      throw new InventoryError("The work-order issue changed before reversal; reload and retry.");
    }
    const itemLabels = await loadItemLabels(tx, orgId, lockedSources.map((movement) => movement.item_id));
    for (const movement of lockedSources) await restoreIssueLayers(tx as Runner, orgId, movement, actorId);
    const reversalEntryId = await reverseInventoryJournal(tx as Runner, orgId, actorId,
      peek.journal_entry_id, input.reversalDate, reason, { allowManufacturingOrigin: true });
    const entry = (await tx.execute<{ custom: Record<string, unknown> }>(sql`
      select custom from journal_entries where org_id=${orgId} and id=${peek.journal_entry_id}`)).rows[0];
    const isBackflush = typeof entry?.custom?.backflush_trigger === "string";
    const reversalIds: string[] = [];
    for (const movement of lockedSources) {
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into inventory_movements
          (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
           quantity, unit_cost, total_value, journal_entry_id, reverses_movement_id, reversal_reason,
           status, memo, created_by, updated_by)
        values (${orgId}, ${movement.subsidiary_id}, ${movement.item_id}, 'return', ${input.reversalDate},
          ${movement.stock_location_id}, ${movement.lot_id}, ${movement.serial_id}, ${neg(movement.quantity)},
          ${movement.unit_cost}, ${movement.total_value === null ? null : neg(movement.total_value)},
          ${reversalEntryId}, ${movement.id}, ${reason}, 'posted',
          ${"Reversal of work order " + order.number + " for " + (itemLabels.get(movement.item_id) ?? "component item") + ": " + reason},
          ${actorId}, ${actorId}) returning id`);
      const reversalId = rowOrNotFound(inserted.rows).id;
      reversalIds.push(reversalId);
      const audit = await tx.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'inventory_movements', ${movement.id}, 'void',
          ${JSON.stringify({ reason, reversalDate: input.reversalDate, reversalMovementId: reversalId, reversalEntryId })}::jsonb,
          ${actorId}) returning id`);
      rowOrNotFound(audit.rows);
      if (movement.serial_id) {
        const serial = await tx.execute<{ id: string }>(sql`
          update serials set status='in_stock', current_stock_location_id=${movement.stock_location_id},
            updated_at=now(), updated_by=${actorId}
           where org_id=${orgId} and id=${movement.serial_id} and status='shipped' returning id`);
        if (serial.rows.length !== 1) throw new InventoryError("Serial " + (movement.serial_number ?? "evidence") + " changed before issue reversal.");
      }
    }
    const totals = new Map<string, string>();
    for (const movement of lockedSources) totals.set(movement.item_id, add(totals.get(movement.item_id) ?? "0", neg(movement.quantity)));
    const materials = await loadMaterials(tx, orgId, order.id, true);
    for (const [itemId, total] of totals) {
      let remaining = toUnits(total);
      const candidates = materials.filter((line) => line.component_item_id === itemId);
      for (const line of candidates) {
        if (remaining <= 0n) break;
        const field: "issued_qty" | "backflush_qty" = isBackflush ? "backflush_qty" : "issued_qty";
        const available = toUnits(line[field]);
        const decrease = available < remaining ? available : remaining;
        if (decrease <= 0n) continue;
        const next = fromUnits(available - decrease);
        const updated = await tx.execute<{ id: string }>(sql`
          update mfg_wo_materials set ${sql.raw(field)}=${next}, updated_by=${actorId}, updated_at=now()
           where org_id=${orgId} and work_order_id=${order.id} and id=${line.id}
             and ${sql.raw(field)}=${line[field]} returning id`);
        if (updated.rows.length !== 1) throw new InventoryError("Material " + materialLabel(line) + " changed before issue reversal.");
        await auditChange(tx, { orgId, actorId, table: "mfg_wo_materials", rowId: line.id, action: "update",
          before: { [isBackflush ? "backflushQty" : "issuedQty"]: line[field] },
          after: { [isBackflush ? "backflushQty" : "issuedQty"]: next, reversedEntryId: peek.journal_entry_id } });
        remaining -= decrease;
      }
      if (remaining !== 0n) throw new InventoryError("Work-order material counters do not cover reversed issue quantity for "
        + (candidates[0] ? materialLabel(candidates[0]) : (await loadItemLabels(tx, orgId, [itemId])).get(itemId) ?? "component item") + ".");
    }
    return { movementIds: reversalIds.sort(), entryId: reversalEntryId, alreadyReversed: false };
  });
}
