import { sumOriginalCosts } from "./original-cost.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, isZero, neg, sum } from "../money/money.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext, uuidArray } from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import { assertStockLocationAdmitsSubsidiary, assertNoForeignOnHand, resolveProfile, assertMovementOwner, assertInventoryFeature } from "./profile-policy.ts";
import { postInventoryEntry } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, getOnHandWith, lockInventoryPosition, persistReceiptMoney } from "./position.ts";
import { consumeLayers, recordConsumptions, addLayerAtCost } from "./cost-layers.ts";

export interface TransferInput {
  itemId: string;
  fromStockLocationId: string;
  toStockLocationId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
  subsidiaryId: string;
  date: string;
  memo?: string | null;
}

/**
 * Move stock between two locations at its carried cost. Source layers are
 * consumed (by the item's method), the destination gains the value, and a
 * location-reclass entry posts only when the two locations map to different
 * `locations` dimensions (else it's a pure subledger move). Value is unchanged.
 */
export async function transferInventory(
  orgId: string,
  actorId: string | null,
  input: TransferInput,
): Promise<{
  fromMovementId: string;
  toMovementId: string;
  entryId: string | null;
  value: string;
}> {
  return db.transaction((tx) =>
    transferInventoryTx(tx, orgId, actorId, input),
  );
}

/** Recover only an untouched, exactly reconciling legacy moving-average transit pool. */
async function restoreLegacyTransitProvenance(
  tx: Runner, orgId: string, actorId: string | null, input: TransferInput,
): Promise<boolean> {
  // The caller owns the item/location position lock. Other order shipments and
  // receipts cannot change either the pool or their line evidence until commit.
  const transit = (await tx.execute(sql`select id from stock_locations
    where org_id=${orgId} and id=${input.fromStockLocationId} and kind='transit' for share`)).rows[0];
  if (!transit) return false;
  const layers = (await tx.execute<{
    id: string; source_movement_id: string; original_quantity: string; remaining_quantity: string; unit_cost: string;
  }>(sql`select id,source_movement_id,original_quantity,remaining_quantity,unit_cost from cost_layers
    where org_id=${orgId} and item_id=${input.itemId} and stock_location_id=${input.fromStockLocationId}
      and subsidiary_id=${input.subsidiaryId} and remaining_quantity>0 order by id for update`)).rows;
  if (!layers.length || layers.some((layer) => cmp(layer.original_quantity, layer.remaining_quantity) !== 0)) return false;
  const consumed = (await tx.execute(sql`select id from cost_layer_consumptions
    where org_id=${orgId} and cost_layer_id=any(${uuidArray(layers.map((layer) => layer.id))}::uuid[]) limit 1`)).rows[0];
  if (consumed) return false;
  const shipments = (await tx.execute<{ id: string; quantity: string; total_value: string; unit_cost: string; moved_at: string }>(sql`
    select inbound.id,inbound.quantity,inbound.total_value,inbound.unit_cost,inbound.moved_at::text
      from transfer_orders o join transfer_order_lines l on l.org_id=o.org_id and l.transfer_order_id=o.id
      join inventory_movements outbound on outbound.org_id=l.org_id and outbound.id=l.ship_movement_id
      join inventory_movements inbound on inbound.org_id=outbound.org_id and inbound.paired_movement_id=outbound.id
     where o.org_id=${orgId} and o.status='in_transit' and o.subsidiary_id=${input.subsidiaryId}
       and inbound.stock_location_id=${input.fromStockLocationId} and inbound.item_id=${input.itemId}
       and inbound.subsidiary_id=o.subsidiary_id and outbound.subsidiary_id=o.subsidiary_id
       and outbound.stock_location_id=o.from_stock_location_id and outbound.item_id=inbound.item_id
       and inbound.kind='transfer_in' and outbound.kind='transfer_out' and inbound.status='posted' and outbound.status='posted'
       and l.item_id=inbound.item_id and l.quantity_shipped=inbound.quantity and l.quantity_received=0
       and inbound.quantity>0 and outbound.quantity=-inbound.quantity and inbound.total_value>=0
       and outbound.total_value=-inbound.total_value and inbound.unit_cost is not null
       and (o.transit_stock_location_id is null or o.transit_stock_location_id=inbound.stock_location_id)
       and not exists(select 1 from inventory_movements reversal where reversal.org_id=${orgId}
         and reversal.reverses_movement_id in (inbound.id,outbound.id))
     order by inbound.moved_at,inbound.created_at,inbound.id`)).rows;
  const shipmentIds = new Set(shipments.map((shipment) => shipment.id));
  if (!shipments.length || shipmentIds.size !== shipments.length ||
      layers.some((layer) => !shipmentIds.has(layer.source_movement_id)) ||
      cmp(sum(layers.map((layer) => layer.remaining_quantity)), sum(shipments.map((shipment) => shipment.quantity))) !== 0 ||
      cmp(sum(layers.map((layer) => extendCost(layer.remaining_quantity, layer.unit_cost))), sum(shipments.map((shipment) => shipment.total_value))) !== 0) {
    return false;
  }
  for (const layer of layers) {
    await tx.execute(sql`update cost_layers set original_quantity='0',remaining_quantity='0',remaining_original_cost=case when remaining_original_cost is null then null else 0 end,updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${layer.id}`);
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${orgId},'cost_layers',${layer.id},'update',${JSON.stringify({
        reason: "Restore untouched legacy transit shipment provenance from immutable movement evidence",
        before: layer, after: { original_quantity: "0.0000", remaining_quantity: "0.0000" },
        shipmentMovementIds: [...shipmentIds],
      })}::jsonb,${actorId})`);
  }
  for (const shipment of shipments) {
    await addLayerAtCost(tx, orgId, input.subsidiaryId, input.itemId, input.fromStockLocationId,
      shipment.quantity, shipment.total_value, "moving_average", shipment.id, shipment.moved_at.slice(0, 10),
      actorId, shipment.unit_cost, null);
  }
  return true;
}

export async function transferInventoryTx(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  input: TransferInput & { sourceReceiptMovementId?: string; expectedSourceValue?: string; postingBookId?: string },
): Promise<{
  fromMovementId: string;
  toMovementId: string;
  entryId: string | null;
  value: string;
}> {
  // Same early gate as receipts: junk must name InventoryError (not a bare
  // Error) and oversized figures must refuse before any journal math.
  const quantity = persistReceiptMoney(input.quantity, "transfer quantity");
  if (cmp(quantity, "0") <= 0)
    throw new InventoryError("transfer quantity must be positive");
  if (input.fromStockLocationId === input.toStockLocationId)
    throw new InventoryError("transfer needs two different locations");
  await assertInventoryFeature(tx, orgId);
  const period = await periodForDate(orgId, input.date, tx);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = input.postingBookId ?? await primaryBookId(orgId, tx);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId, tx);
  const ctx = await loadSubsidiaryContext(tx, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);

  // Serialize every transfer touching either position. Sorting the lock keys
  // prevents two opposite-direction transfers from deadlocking.
  for (const locationId of [
    input.fromStockLocationId,
    input.toStockLocationId,
  ].sort()) {
    await lockInventoryPosition(tx, input.itemId, locationId);
    await assertStockLocationAdmitsSubsidiary(
      tx,
      orgId,
      ctx,
      locationId,
      input.subsidiaryId,
    );
  }
  // Costing policy revisions lock this same profile before revaluing layers;
  // take a share lock only after both positions are fenced, then use this
  // transaction-local policy snapshot for the entire transfer.
  const profile = await resolveProfile(orgId, input.itemId, tx, true);
  assertTracking(
    profile,
    { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
    "transfer",
  );
  await validateTrackingSelection(
    tx,
    orgId,
    input.itemId,
    input.fromStockLocationId,
    profile,
    {
      quantity: input.quantity,
      lotId: input.lotId,
      serialId: input.serialId,
    },
    "transfer",
  );
  let onHand = await getOnHandWith(
    tx,
    orgId,
    input.itemId,
    input.fromStockLocationId,
    { lotId: input.lotId, serialId: input.serialId, subsidiaryId: input.subsidiaryId,
      sourceReceiptMovementId: input.sourceReceiptMovementId },
  );
  if (input.sourceReceiptMovementId && (
    cmp(onHand.quantity, input.quantity) !== 0 ||
    input.expectedSourceValue == null || cmp(onHand.value, input.expectedSourceValue) !== 0
  )) {
    const restored = profile.costingMethod === "moving_average" &&
      await restoreLegacyTransitProvenance(tx, orgId, actorId, input);
    if (restored) {
      onHand = await getOnHandWith(tx, orgId, input.itemId, input.fromStockLocationId,
        { subsidiaryId: input.subsidiaryId, sourceReceiptMovementId: input.sourceReceiptMovementId });
    }
    if (!restored || cmp(onHand.quantity, input.quantity) !== 0 || input.expectedSourceValue == null ||
        cmp(onHand.value, input.expectedSourceValue) !== 0) {
      throw new InventoryError("transfer shipment layers have changed; reconcile the shipment before receiving it");
    }
  }
  if (cmp(input.quantity, onHand.quantity) > 0) {
    await assertNoForeignOnHand(
      tx,
      orgId,
      input.itemId,
      input.fromStockLocationId,
      input.subsidiaryId,
    );
    throw new InventoryError(
      `insufficient stock at source: need ${input.quantity}, on hand ${onHand.quantity}`,
    );
  }

  const locDims = (await tx.execute<{ id: string; location_id: string }>(sql`
    select id, location_id from stock_locations where org_id = ${orgId} and id in (${input.fromStockLocationId}, ${input.toStockLocationId})`));
  if (locDims.rows.length !== 2) {
    throw new InventoryError(
      "both transfer locations must belong to the organization",
    );
  }
  const fromDim =
    locDims.rows.find((r) => r.id === input.fromStockLocationId)?.location_id ??
    null;
  const toDim =
    locDims.rows.find((r) => r.id === input.toStockLocationId)?.location_id ??
    null;

  const { consumptions } = await consumeLayers(
    tx,
    orgId,
    profile,
    input.itemId,
    input.fromStockLocationId,
    input.quantity,
    onHand,
    onHand.unitCost,
    { lotId: input.lotId, serialId: input.serialId, sourceReceiptMovementId: input.sourceReceiptMovementId },
    input.subsidiaryId,
    actorId,
  );
  // A transfer carries the existing basis, including fractional rounding and
  // any controlled write-down of standard-cost layers. It never remeasures
  // the stock merely because its location changed.
  const cost = sum(consumptions.map((consumption) => consumption.cost));
  const unitCost = unitCostPerQuantity(cost, input.quantity)!;

  // Optional location-reclass entry (value nets to zero, dimensions differ).
  let entryId: string | null = null;
  if (fromDim && toDim && fromDim !== toDim && !isZero(cost)) {
    entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      actorId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-XFER-${input.date}-${input.itemId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      memo: input.memo ?? "Inventory transfer",
      lines: [
        {
          accountId: profile.assetAccountId,
          amount: cost,
          locationId: toDim,
          memo: input.memo,
        },
        {
          accountId: profile.assetAccountId,
          amount: neg(cost),
          locationId: fromDim,
          memo: input.memo,
        },
      ],
    });
  }

  // A posted movement is immutable (no post-insert UPDATE), so the id is
  // generated up front and only the transfer_in leg carries the pairing
  // link back to the transfer_out (one direction is enough to relate them).
  const transferQuantity = persistReceiptMoney(input.quantity, "transfer quantity");
  const fromMovementId = randomUUID();
  await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id,
         serial_id, quantity, unit_cost, total_value, journal_entry_id, status,
         memo, created_by, updated_by)
      values (${fromMovementId}, ${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'transfer_out',
              ${input.date}, ${input.fromStockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${neg(transferQuantity)}, ${unitCost},
              ${neg(cost)}, ${entryId}, 'posted', ${input.memo ?? null},
              ${actorId}, ${actorId})`);
  const toMovementId = randomUUID();
  await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id,
         serial_id, quantity, unit_cost, total_value, journal_entry_id,
         paired_movement_id, status, memo, created_by, updated_by)
      values (${toMovementId}, ${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'transfer_in',
              ${input.date}, ${input.toStockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${transferQuantity}, ${unitCost}, ${cost},
              ${entryId}, ${fromMovementId}, 'posted', ${input.memo ?? null},
              ${actorId}, ${actorId})`);

  await recordConsumptions(
    tx,
    orgId,
    input.subsidiaryId,
    consumptions,
    fromMovementId,
    actorId,
  );
  const carried = profile.costingMethod === "fifo"
    ? consumptions.map((consumption) => ({ quantity: consumption.quantity, value: consumption.cost, unitCost: consumption.unitCost, originalCost: consumption.originalCost ?? null }))
    : [{ quantity: input.quantity, value: cost, unitCost, originalCost: sumOriginalCosts(consumptions.map((consumption) => consumption.originalCost ?? null)) }];
  for (const fragment of carried) {
    await addLayerAtCost(tx, orgId, input.subsidiaryId, input.itemId,
      input.toStockLocationId, fragment.quantity, fragment.value, profile.costingMethod,
      toMovementId, input.date, actorId, fragment.unitCost, fragment.originalCost);
  }
  if (profile.tracking === "serial") {
    await tx.execute(sql`
      update serials
         set status = 'in_stock',
             current_stock_location_id = ${input.toStockLocationId},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${input.serialId} and org_id = ${orgId}
    `);
  }

  return { fromMovementId, toMovementId, entryId, value: cost };
}
