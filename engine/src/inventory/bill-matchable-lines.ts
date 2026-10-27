import { sql } from "drizzle-orm";
import { add, mulRate } from "../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { sameInventoryUnit, toBaseQuantity } from "./costing.ts";
import { isJsonRecord } from "./document-lines.ts";
import { liveReceiptQuantity } from "./return-quantities.ts";

/**
 * The one definition of "received" every purchase-order matching reader
 * shares: the posting guard (bill-order-matching.ts), the Match dialog
 * and match action (payables/vendor-bill-matching.ts), and the bill
 * receipt drain (documents-purchasing.ts).
 *
 * A purchase-order line carries received-not-billed cover from either of
 * two evidences, and the readers must agree on both: the order line's
 * received counter (advanced by every receive path in the same transaction
 * as its goods receipt) and the live stock the goods receipts still hold
 * for that line (posted receipt movements net of their reversals, plus
 * confirmed drop-ship receipts that never move stock). Either evidence
 * alone proves the vendor delivered: counters and movements are written
 * together, but voids, returns, and historic data can strand one without
 * the other, and a bill that trusts only one side receives the stock a
 * second time. Cover is the greater of the two, less what bills already
 * claimed, capped by the ordered remainder.
 *
 * All cover arithmetic runs in the item's base units at eight-decimal
 * quantity precision so lines raised in different units compare exactly;
 * conversions round down, so offered cover never exceeds either evidence.
 */
export interface MatchableBillLineScope {
  itemId: string;
  unit: string | null;
  /** The bill's vendor; null matches only a vendor-less order. */
  partyId: string | null;
  /**
   * The bill's legal entity; null is the hierarchy root (the posting
   * default), matching an order that names the root explicitly or leaves
   * it null. Anything else matches only its own entity.
   */
  subsidiaryId: string | null;
}

export interface MatchablePurchaseOrderLine {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderLineId: string;
  purchaseOrderLineNumber: number;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  unitPrice: string;
  orderedQuantity: string;
  fulfilledQuantity: string;
  billedQuantity: string;
  cancelledQuantity: string;
  /** Unified received-and-unbilled cover, in the order line's own unit. */
  billableQuantity: string;
  /** Live received quantity still held for the line, in base units. */
  liveReceivedQuantity: string;
  /** Live received value still held for the line. */
  liveReceivedValue: string;
}

/** The purchase-order line a bill line was drawn from, from either writer's evidence. */
export function billLinePurchaseOrderLineId(custom: unknown): string | null {
  if (!isJsonRecord(custom)) return null;
  const direct = custom.purchaseOrderLineId;
  if (typeof direct === "string" && direct) return direct;
  const capture = custom.apCaptureEvidence;
  if (
    isJsonRecord(capture) &&
    typeof capture.purchaseOrderLineId === "string" &&
    capture.purchaseOrderLineId
  ) {
    return capture.purchaseOrderLineId;
  }
  return null;
}

/**
 * Legal-entity comparison with the posting default: a null subsidiary IS
 * the hierarchy root, so a bill that leaves the entity blank matches an
 * order that names the root explicitly, and vice versa. Anything else
 * matches only its own entity.
 */
export async function resolveEntityScope(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
): Promise<string> {
  if (subsidiaryId) return subsidiaryId;
  return (await loadSubsidiaryContext(runner, orgId)).rootId;
}

interface ItemProfile {
  baseUnit: string;
  conversions: Record<string, number>;
}

async function itemProfile(
  runner: SqlExecutor,
  orgId: string,
  itemId: string,
): Promise<ItemProfile | null> {
  const row = (
    await runner.execute<{ base_unit: string; unit_conversions: unknown }>(
      sql`
    select base_unit, unit_conversions
      from item_inventory_profiles
     where org_id = ${orgId} and item_id = ${itemId}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  return {
    baseUnit: row.base_unit,
    conversions: isJsonRecord(row.unit_conversions)
      ? (row.unit_conversions as Record<string, number>)
      : {},
  };
}

const QUANTITY_SCALE = 100_000_000n;

/**
 * Live stock the goods receipts still hold for a purchase-order line, in
 * the item's base units: posted receipt movements on receipt lines whose
 * immutable evidence names that source line, each net of its posted
 * reversals through the shared live-receipt helper, plus confirmed
 * drop-ship receipts that never move stock. A receipt the return flow
 * treats as dead nets to zero here, and a confirmed drop-ship receipt
 * converts from its receipt-line unit, so the two legs share one unit.
 */
export async function livePurchaseOrderLineReceipts(
  runner: SqlExecutor,
  orgId: string,
  purchaseOrderLineId: string,
): Promise<{ quantity: string; value: string }> {
  const source = (
    await runner.execute<{ item_id: string }>(
      sql`
    select item_id from document_lines
     where org_id = ${orgId} and id = ${purchaseOrderLineId}`,
      "objects",
    )
  )[0];
  if (!source) return { quantity: "0", value: "0" };
  const profile = await itemProfile(runner, orgId, source.item_id);
  const receipts = await runner.execute<{ id: string }>(
    sql`
    select m.id
      from inventory_movements m
      join document_lines rl on rl.id = m.document_line_id and rl.org_id = m.org_id
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where m.org_id = ${orgId} and m.kind = 'receipt' and m.status = 'posted'
       and rd.kind = 'purchase_receipt'
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
  `,
    "objects",
  );
  // One movement per receipt line in practice; each nets its own reversals
  // through the helper the vendor-return guard shares, so both readers
  // agree on what "received" means.
  let quantity = "0";
  let value = "0";
  for (const receipt of receipts) {
    const live = await liveReceiptQuantity(runner, orgId, receipt.id);
    quantity = fromQuantityUnits(toQuantityUnits(quantity) + toQuantityUnits(live.quantity));
    value = add(value, live.value);
  }
  const corrections = (
    await runner.execute<{ quantity: string; value: string }>(
      sql`
    select coalesce(sum(c.quantity + coalesce((
             select sum(r.quantity) from inventory_movements r
              where r.org_id = c.org_id and r.reverses_movement_id = c.id and r.status = 'posted'
           ), 0)), 0)::text as quantity,
           coalesce(sum(c.total_value + coalesce((
             select sum(r.total_value) from inventory_movements r
              where r.org_id = c.org_id and r.reverses_movement_id = c.id and r.status = 'posted'
           ), 0)), 0)::text as value
      from inventory_movements c
      join document_lines rl on rl.id = c.document_line_id and rl.org_id = c.org_id
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where c.org_id = ${orgId} and c.kind = 'issue' and c.status = 'posted'
       and rd.kind = 'purchase_receipt'
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
       and (c.idempotency_key like 'receipt-remainder-%'
            or c.idempotency_key like 'receipt-quantity-%')
  `,
      "objects",
    )
  )[0];
  quantity = fromQuantityUnits(
    toQuantityUnits(quantity) + toQuantityUnits(corrections?.quantity ?? "0"),
  );
  value = add(value, corrections?.value ?? "0");
  const dropShipConfirmations = await runner.execute<{
    quantity: string;
    value: string;
    fx_rate: string;
    unit: string | null;
  }>(
    sql`
    select rl.quantity::text as quantity, rl.amount::text as value, rd.fx_rate::text as fx_rate, rl.unit as unit
      from document_lines rl
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where rl.org_id = ${orgId}
       and rd.kind = 'purchase_receipt'
       and rd.status in ('approved', 'posted')
       and rd.custom ? 'dropShipConfirmation'
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
  `,
    "objects",
  );
  for (const confirmation of dropShipConfirmations) {
    value = add(value, mulRate(confirmation.value, confirmation.fx_rate));
    // Receipt lines copy the order line's unit; convert to base so this
    // leg shares the movements' unit instead of mixing them.
    quantity = profile
      ? fromQuantityUnits(
          toQuantityUnits(quantity) +
            toBaseFloorUnits(
              confirmation.quantity,
              baseFactor(profile, confirmation.unit, "drop-ship receipt line"),
            ),
        )
      : fromQuantityUnits(toQuantityUnits(quantity) + toQuantityUnits(confirmation.quantity));
  }
  return { quantity, value };
}

/** Base units per one order-line unit, as eight-decimal quantity units. */
function baseFactor(profile: ItemProfile, unit: string | null, label: string): bigint {
  return toQuantityUnits(toBaseQuantity("1", unit, profile.conversions, profile.baseUnit, label));
}

/** A quantity into base units, rounded down so cover is never overstated. */
function toBaseFloorUnits(quantity: string, factor: bigint): bigint {
  const net = toQuantityUnits(quantity);
  if (net <= 0n) return 0n;
  return (net * factor) / QUANTITY_SCALE;
}

export function billableRemainderUnits(input: {
  orderedQuantity: string;
  billedQuantity: string;
  cancelledQuantity: string;
  fulfilledQuantity: string;
  requiresReceipt: boolean;
}): bigint {
  // The same ceiling order conversion bills from: stock lines bill only
  // received-and-unbilled cover, other lines the ordered remainder.
  const remaining =
    toQuantityUnits(input.orderedQuantity) -
    toQuantityUnits(input.cancelledQuantity) -
    toQuantityUnits(input.billedQuantity);
  if (remaining <= 0n) return 0n;
  if (!input.requiresReceipt) return remaining;
  const cover = toQuantityUnits(input.fulfilledQuantity) - toQuantityUnits(input.billedQuantity);
  if (cover <= 0n) return 0n;
  return cover < remaining ? cover : remaining;
}

export interface LinkedBillReceipt {
  billId: string;
  billNumber: string;
  /** Live received quantity on that bill for the order line, base units. */
  quantity: string;
  /** Live received value on that bill for the order line. */
  value: string;
}

/**
 * Stock vendor bills already received for a purchase-order line through
 * the bill drain: posted receipt movements on vendor-bill lines whose
 * immutable link names that order line, each net of its posted reversals
 * through the shared live-receipt helper. Linked bills never receive
 * through the drain anymore, so cover here is legacy data — but the
 * receiving side must still count it, or the goods receipt brings the
 * same units a third time. Unlinked bill-direct stock is deliberately
 * invisible here: with no order line named, no receipt line can attribute
 * it, and the receipt stays permissive.
 */
export async function liveLinkedBillReceipts(
  runner: SqlExecutor,
  orgId: string,
  purchaseOrderLineId: string,
): Promise<LinkedBillReceipt[]> {
  const movements = await runner.execute<{ id: string; bill_id: string; bill_number: string }>(
    sql`
    select m.id, bill.id as bill_id, bill.document_number as bill_number
      from inventory_movements m
      join document_lines bl on bl.id = m.document_line_id and bl.org_id = m.org_id
      join documents bill on bill.id = bl.document_id and bill.org_id = bl.org_id
     where m.org_id = ${orgId} and m.kind = 'receipt' and m.status = 'posted'
       and bill.kind = 'vendor_bill'
       and (bl.custom->>'purchaseOrderLineId' = ${purchaseOrderLineId}
            or bl.custom->'convertedFrom'->>'lineId' = ${purchaseOrderLineId})
     order by bill.document_number, m.id
  `,
    "objects",
  );
  const byBill = new Map<string, LinkedBillReceipt>();
  for (const movement of movements) {
    const live = await liveReceiptQuantity(runner, orgId, movement.id);
    if (toQuantityUnits(live.quantity) <= 0n) continue;
    const entry = byBill.get(movement.bill_id) ?? {
      billId: movement.bill_id,
      billNumber: movement.bill_number,
      quantity: "0",
      value: "0",
    };
    entry.quantity = fromQuantityUnits(
      toQuantityUnits(entry.quantity) + toQuantityUnits(live.quantity),
    );
    entry.value = add(entry.value, live.value);
    byBill.set(movement.bill_id, entry);
  }
  return [...byBill.values()];
}

/**
 * Linked bill-received cover floored into a purchase-order line's own
 * unit, for the receiving side: a goods receipt may only bring what the
 * linked bills have not already brought. Without a costing profile there
 * is no base pivot, so any linked receipt presence reports zero cover and
 * the caller refuses fail-closed naming the bills.
 */
export async function linkedBillReceivedCover(
  runner: SqlExecutor,
  orgId: string,
  line: { purchaseOrderLineId: string; itemId: string; unit: string | null },
): Promise<{ quantity: string; bills: { billId: string; billNumber: string }[] }> {
  const linked = await liveLinkedBillReceipts(runner, orgId, line.purchaseOrderLineId);
  const bills = linked.map(({ billId, billNumber }) => ({ billId, billNumber }));
  if (linked.length === 0) return { quantity: "0", bills };
  const profile = await itemProfile(runner, orgId, line.itemId);
  if (!profile) return { quantity: "0", bills };
  const factor = baseFactor(profile, line.unit, "purchase-order line");
  let base = 0n;
  for (const entry of linked) base += toQuantityUnits(entry.quantity);
  return { quantity: fromQuantityUnits((base * QUANTITY_SCALE) / factor), bills };
}

export interface UnifiedUnbilledCover {
  /** Unified received-and-unbilled cover in the order line's own unit (floored). */
  billableQuantity: string;
  /** Unified cover before the ordered-remainder cap, in the order line's own unit (floored). */
  coverQuantity: string;
  /** Live received quantity still held, in base units. */
  liveReceivedQuantity: string;
  /** Live received value still held. */
  liveReceivedValue: string;
}

/**
 * The one cover computation: counter cover (received less billed) and
 * live cover (live receipts less billed) in base units, the greater of
 * the two capped by the ordered remainder, floored back into the order
 * line's unit. Without a costing profile there is no base pivot, so the
 * line falls back to its counter cover only — an unprofiled bill line
 * cannot clear received-not-billed anyway.
 */
export async function unifiedUnbilledCover(
  runner: SqlExecutor,
  orgId: string,
  line: {
    purchaseOrderLineId: string;
    itemId: string;
    unit: string | null;
    orderedQuantity: string;
    fulfilledQuantity: string;
    billedQuantity: string;
    cancelledQuantity: string;
  },
): Promise<UnifiedUnbilledCover> {
  const empty = {
    billableQuantity: "0",
    coverQuantity: "0",
    liveReceivedQuantity: "0",
    liveReceivedValue: "0",
  };
  const profile = await itemProfile(runner, orgId, line.itemId);
  const live = await livePurchaseOrderLineReceipts(runner, orgId, line.purchaseOrderLineId);
  if (!profile) {
    const billable = billableRemainderUnits({
      orderedQuantity: line.orderedQuantity,
      billedQuantity: line.billedQuantity,
      cancelledQuantity: line.cancelledQuantity,
      fulfilledQuantity: line.fulfilledQuantity,
      requiresReceipt: true,
    });
    return {
      ...empty,
      billableQuantity: fromQuantityUnits(billable),
      coverQuantity: fromQuantityUnits(billable),
    };
  }
  const factor = baseFactor(profile, line.unit, "purchase-order line");
  const orderedOpen =
    toQuantityUnits(line.orderedQuantity) -
    toQuantityUnits(line.cancelledQuantity) -
    toQuantityUnits(line.billedQuantity);
  if (orderedOpen <= 0n)
    return { ...empty, liveReceivedQuantity: live.quantity, liveReceivedValue: live.value };
  const counterCover = toBaseFloorUnits(
    fromQuantityUnits(
      toQuantityUnits(line.fulfilledQuantity) - toQuantityUnits(line.billedQuantity),
    ),
    factor,
  );
  // Billed cover is shared: live receipts less what bills already claimed.
  const billedBase = toBaseFloorUnits(line.billedQuantity, factor);
  const liveCover = toQuantityUnits(live.quantity) - billedBase;
  const coverBase = counterCover > liveCover ? counterCover : liveCover;
  if (coverBase <= 0n)
    return { ...empty, liveReceivedQuantity: live.quantity, liveReceivedValue: live.value };
  const orderedBase = toBaseFloorUnits(fromQuantityUnits(orderedOpen), factor);
  const billableBase = coverBase < orderedBase ? coverBase : orderedBase;
  // Floor back into the order line's unit so the offered quantity stays
  // inside both evidences.
  const floored = (base: bigint) => (base * QUANTITY_SCALE) / factor;
  return {
    billableQuantity: fromQuantityUnits(floored(billableBase)),
    coverQuantity: fromQuantityUnits(floored(coverBase)),
    liveReceivedQuantity: live.quantity,
    liveReceivedValue: live.value,
  };
}

/**
 * Every purchase-order line the scoped bill line can match, in dialog
 * order. Storage filters the vendor, entity, approval, and item; unit
 * spellings fold in this process so a database collation can never
 * disagree with the match's own comparison. A line appears when its
 * unified cover (counter or live) is outstanding, and the offered
 * quantity is the unified remainder.
 */
export async function matchablePurchaseOrderLines(
  runner: SqlExecutor,
  orgId: string,
  scope: MatchableBillLineScope,
  /** Receipt guards also fence unreceived commitments; bill pickers offer received cover only. */
  options: { includeUnreceived?: boolean } = {},
): Promise<MatchablePurchaseOrderLine[]> {
  // Both sides resolve through the posting default: a blank entity on
  // either side is the hierarchy root, so blank matches an explicit root
  // but never a non-root entity.
  const rootId = (await loadSubsidiaryContext(runner, orgId)).rootId;
  const entityId = scope.subsidiaryId ?? rootId;
  const rows = await runner.execute<{
    purchase_order_id: string;
    purchase_order_number: string;
    purchase_order_line_id: string;
    purchase_order_line_number: number;
    item_code: string | null;
    item_name: string;
    unit: string | null;
    unit_price: string;
    ordered_quantity: string;
    fulfilled_quantity: string;
    billed_quantity: string;
    cancelled_quantity: string;
  }>(
    sql`
    select d.id as purchase_order_id, d.document_number as purchase_order_number,
           dl.id as purchase_order_line_id, dl.line_number as purchase_order_line_number,
           i.code as item_code, i.name as item_name,
           dl.unit, dl.unit_price::text as unit_price,
           dl.quantity::text as ordered_quantity, dl.quantity_fulfilled::text as fulfilled_quantity,
           dl.quantity_billed::text as billed_quantity, dl.quantity_cancelled::text as cancelled_quantity
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId}
       and d.kind = 'purchase_order'
       and d.status = 'approved'
       and dl.item_id = ${scope.itemId}
       and (d.party_id is not distinct from ${scope.partyId})
       and coalesce(d.subsidiary_id, ${rootId}) = ${entityId}
     order by d.document_number, dl.line_number`,
    "objects",
  );
  const baseUnit = (await itemProfile(runner, orgId, scope.itemId))?.baseUnit ?? null;
  const result: MatchablePurchaseOrderLine[] = [];
  for (const row of rows) {
    if (!sameInventoryUnit(row.unit, scope.unit, baseUnit)) continue;
    const cover = await unifiedUnbilledCover(runner, orgId, {
      purchaseOrderLineId: row.purchase_order_line_id,
      itemId: scope.itemId,
      unit: row.unit,
      orderedQuantity: row.ordered_quantity,
      fulfilledQuantity: row.fulfilled_quantity,
      billedQuantity: row.billed_quantity,
      cancelledQuantity: row.cancelled_quantity,
    });
    const remaining = billableRemainderUnits({
      orderedQuantity: row.ordered_quantity,
      billedQuantity: row.billed_quantity,
      cancelledQuantity: row.cancelled_quantity,
      fulfilledQuantity: row.fulfilled_quantity,
      requiresReceipt: false,
    });
    if (
      toQuantityUnits(cover.billableQuantity) <= 0n &&
      (!options.includeUnreceived || remaining <= 0n)
    )
      continue;
    result.push({
      purchaseOrderId: row.purchase_order_id,
      purchaseOrderNumber: row.purchase_order_number,
      purchaseOrderLineId: row.purchase_order_line_id,
      purchaseOrderLineNumber: row.purchase_order_line_number,
      itemCode: row.item_code,
      itemName: row.item_name,
      unit: row.unit,
      unitPrice: row.unit_price,
      orderedQuantity: row.ordered_quantity,
      fulfilledQuantity: row.fulfilled_quantity,
      billedQuantity: row.billed_quantity,
      cancelledQuantity: row.cancelled_quantity,
      billableQuantity: cover.billableQuantity,
      liveReceivedQuantity: cover.liveReceivedQuantity,
      liveReceivedValue: cover.liveReceivedValue,
    });
  }
  return result;
}
