import { consumeOriginalCost, splitOriginalCost, sumOriginalCosts, type OriginalCostLocation } from "./original-cost.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, fromUnits, isZero, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import { consumeFifo, extendCost, exactCostFragments, issueStandard, unitCostPerQuantity, type CostLayer } from "./costing.ts";
import { InventoryError, type InventoryProfile, type Runner } from "./contracts.ts";

export async function resolveProvisionalUnitCost(
  tx: Runner,
  orgId: string,
  profile: InventoryProfile,
  itemId: string,
  subsidiaryId: string,
): Promise<string> {
  if (profile.negativeCostBasis === "configured") {
    if (profile.provisionalUnitCost == null)
      throw new InventoryError(
        "configured negative costing requires a provisional unit cost",
      );
    return profile.provisionalUnitCost;
  }
  if (profile.negativeCostBasis === "standard") {
    if (profile.standardCost == null)
      throw new InventoryError(
        "standard negative costing requires a standard cost",
      );
    return profile.standardCost;
  }
  const last = (await tx.execute<{ unit_cost: string }>(sql`
    select unit_cost from inventory_movements
     where org_id=${orgId} and item_id=${itemId} and subsidiary_id=${subsidiaryId}
       and kind in ('receipt','return','assembly_build','transfer_in')
       and status='posted' and unit_cost is not null
     order by moved_at desc,created_at desc,id desc limit 1
  `));
  if (!last.rows[0])
    throw new InventoryError(
      "negative inventory has no prior receipt cost; configure a provisional or standard cost",
    );
  return last.rows[0].unit_cost;
}

/** Draw `quantity` off layers oldest-first for QUANTITY bookkeeping (standard cost). */
export function planQuantityConsumption(
  layers: { id: string; remaining: string; unit_cost: string }[],
  quantity: string,
): Consumption[] {
  let need = toUnits(quantity);
  const out: Consumption[] = [];
  for (const l of layers) {
    if (need <= 0n) break;
    const avail = toUnits(l.remaining);
    if (avail <= 0n) continue;
    const take = avail < need ? avail : need;
    out.push({
      layerId: l.id,
      quantity: fromUnits(take),
      unitCost: l.unit_cost,
      cost: fromUnits(toUnits(extendCost(l.remaining, l.unit_cost)) - toUnits(extendCost(fromUnits(avail - take), l.unit_cost))),
    });
    need -= take;
  }
  return out;
}

export interface Consumption {
  originalCost?: string | null;
  layerId: string;
  quantity: string;
  unitCost: string;
  cost: string;
}

/**
 * Consume `quantity` of an item from a location's cost layers by the item's
 * costing method. Returns the total cost, the per-unit cost, and the layer
 * consumptions to record. Shared by issue, transfer, and assembly build.
 */
export async function consumeLayers(
  tx: Runner,
  orgId: string,
  profile: InventoryProfile,
  itemId: string,
  stockLocationId: string,
  quantity: string,
  onHand: { quantity: string; value: string; unitCost: string },
  provisionalUnitCost = onHand.unitCost,
  selection: {
    lotId?: string | null;
    serialId?: string | null;
    sourceReceiptMovementId?: string | null;
  } = {},
  /** Consuming entity — only layers it owns are reachable. */
  subsidiaryId?: string,
  actorId: string | null = null,
): Promise<{
  cost: string;
  unitCost: string;
  consumptions: Consumption[];
  shortfallQuantity: string;
}> {
  const lotId = selection.lotId ?? null;
  const serialId = selection.serialId ?? null;
  const sourceReceiptMovementId = selection.sourceReceiptMovementId ?? null;
  const ownershipScope = subsidiaryId
    ? sql`and layer.subsidiary_id = ${subsidiaryId}`
    : sql``;
  const layersRes = (await tx.execute<{ id: string; remaining: string; original_quantity: string; unit_cost: string; source_movement_id: string; subsidiary_id: string; received_at: string; remaining_original_cost: string | null }>(sql`
    select layer.id, layer.remaining_original_cost, layer.remaining_quantity as remaining, layer.original_quantity, layer.unit_cost, layer.source_movement_id, layer.subsidiary_id, layer.received_at::text
      from cost_layers layer
      join inventory_movements source
        on source.id = layer.source_movement_id
       and source.org_id = layer.org_id
     where layer.org_id = ${orgId} and layer.item_id = ${itemId}
       and layer.stock_location_id = ${stockLocationId}
       and layer.remaining_quantity > 0
       ${ownershipScope}
       and (${sourceReceiptMovementId}::uuid is null or source.id = ${sourceReceiptMovementId}::uuid)
       and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
       and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
     -- Keep remeasurement fragments beside their original receipt. A fragment's
     -- random UUID must never move its residual cost ahead of the original
     -- layer or behind a later receipt on the same business date.
     order by layer.received_at, source.created_at, source.id, layer.created_at, layer.id`));
  const layers = layersRes.rows;

  let cost: string;
  let consumptions: Consumption[] = [];
  const requestedUnits = toUnits(quantity);
  const availableUnits = layers.reduce(
    (total, layer) => total + toUnits(layer.remaining),
    0n,
  );
  const coveredUnits =
    availableUnits < requestedUnits ? availableUnits : requestedUnits;
  const shortfallQuantity = fromUnits(requestedUnits - coveredUnits);
  if (profile.costingMethod === "standard") {
    cost = issueStandard(quantity, profile.standardCost ?? onHand.unitCost);
    consumptions = planQuantityConsumption(layers, fromUnits(coveredUnits));
  } else {
    const costingLayers = layers.map((l) => ({
        id: l.id,
        remaining: l.remaining,
        unitCost: l.unit_cost,
      })) as CostLayer[];
    let r = consumeFifo(costingLayers, quantity, provisionalUnitCost);
    const oneAveragePool = profile.costingMethod === "moving_average" && layers.length > 0 && coveredUnits > 0n;
    if (oneAveragePool) {
      const poolValue = sum(layers.map((layer) => extendCost(layer.remaining, layer.unit_cost)));
      const weightedCost = fromUnits(roundDiv(toUnits(poolValue) * coveredUnits, availableUnits));
      const dependsOnResidualRounding = r.consumptions.some((consumption) =>
        cmp(consumption.cost, extendCost(consumption.quantity, consumption.unitCost)) !== 0);
      if (layers.length > 1 || cmp(r.totalCost, add(weightedCost, extendCost(shortfallQuantity, provisionalUnitCost))) !== 0 || dependsOnResidualRounding) {
        // Four-decimal quantities cannot always express the weighted draw by
        // selecting portions of existing rates. Partition ONLY the remaining
        // pool into exact drawn/retained values. Historical consumption rows
        // and their source-layer rates remain unchanged; total value and the
        // inbound movement source are preserved without a GL revaluation.
        // Each drawn fragment must also extend to its cost on its own, so a
        // later re-pool cannot remove residual rounding needed by its reversal.
        const source = layers[0]!;
        const poolBasis = sumOriginalCosts(layers.map((layer) => layer.remaining_original_cost));
        const poolLocation: OriginalCostLocation = { itemId, stockLocationId };
        const drawnBasis = consumeOriginalCost(poolBasis, fromUnits(coveredUnits), fromUnits(availableUnits), poolLocation);
        const partitions = [
          { quantity: fromUnits(coveredUnits), value: weightedCost, consumed: true, basis: drawnBasis },
          { quantity: fromUnits(availableUnits - coveredUnits), value: add(poolValue, neg(weightedCost)), consumed: false,
            basis: poolBasis == null || drawnBasis == null ? null : add(poolBasis, neg(drawnBasis)) },
        ];
        const created: { id: string; quantity: string; unitCost: string; consumed: boolean; originalCost: string | null }[] = [];
        for (const layer of layers) {
          await tx.execute(sql`update cost_layers set original_quantity=original_quantity-remaining_quantity,
            remaining_quantity='0',remaining_original_cost=case when remaining_original_cost is null then null else 0 end,updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${layer.id}`);
        }
        for (const partition of partitions) {
          if (isZero(partition.quantity)) continue;
          const fragments = exactCostFragments(partition.quantity, partition.value);
          const bases = splitOriginalCost(partition.basis, fragments.map((fragment) => fragment.quantity), fragments.map((fragment) => extendCost(fragment.quantity, fragment.unitCost)), poolLocation);
          for (const [index, fragment] of fragments.entries()) {
            const id = randomUUID();
            await tx.execute(sql`insert into cost_layers
              (id,org_id,subsidiary_id,item_id,stock_location_id,source_movement_id,received_at,
               original_quantity,remaining_quantity,unit_cost,remaining_original_cost,created_at,created_by,updated_by)
              values (${id},${orgId},${source.subsidiary_id},${itemId},${stockLocationId},${source.source_movement_id},${source.received_at},
                ${fragment.quantity},${fragment.quantity},${fragment.unitCost},${bases[index]},clock_timestamp(),${actorId},${actorId})`);
            created.push({ id, ...fragment, consumed: partition.consumed, originalCost: bases[index]! });
          }
        }
        for (const layer of layers) {
          await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
            values (${orgId},'cost_layers',${layer.id},'update',${JSON.stringify({
              reason: "Partition remaining moving-average basis for an exact weighted withdrawal",
              before: layer,
              after: { original_quantity: add(layer.original_quantity, neg(layer.remaining)), remaining_quantity: "0.0000" },
              sourceMovementId: source.source_movement_id, quantity, value: weightedCost,
              createdFragments: created,
            })}::jsonb,${actorId})`);
        }
        r = consumeFifo(created.filter((fragment) => fragment.consumed).map((fragment) => ({
          id: fragment.id, remaining: fragment.quantity, unitCost: fragment.unitCost,
        })), fromUnits(coveredUnits), "0");
        if (cmp(r.totalCost, weightedCost) !== 0 || !isZero(r.shortfallQuantity)) {
          throw new InventoryError("moving-average partition did not preserve its weighted withdrawal value");
        }
        r.totalCost = add(r.totalCost, extendCost(shortfallQuantity, provisionalUnitCost));
        for (const consumption of r.consumptions) {
          const fragment = created.find((entry) => entry.id === consumption.layerId)!;
          consumptions.push({ ...consumption, originalCost: fragment.originalCost });
        }
      }
    }

    cost = r.totalCost;
    if (!consumptions.length) consumptions = r.consumptions.map((c) => ({
      layerId: c.layerId,
      quantity: c.quantity,
      unitCost: c.unitCost,
      cost: c.cost,
    }));
  }
  for (const consumption of consumptions) {
    if (consumption.originalCost !== undefined) continue;
    const layer = layers.find((entry) => entry.id === consumption.layerId)!;
    consumption.originalCost = layer.remaining_original_cost != null &&
      cmp(layer.remaining_original_cost, extendCost(layer.remaining, layer.unit_cost)) === 0
      ? consumption.cost
      : consumeOriginalCost(layer.remaining_original_cost, consumption.quantity, layer.remaining, {
          itemId,
          stockLocationId,
          layerId: layer.id,
        });
  }
  const unitCost = isZero(quantity)
    ? "0"
    : unitCostPerQuantity(cost, quantity)!;
  return { cost, unitCost, consumptions, shortfallQuantity };
}

/** Draw down consumed layers and record the consumptions against a movement. */
export async function recordConsumptions(
  tx: Runner,
  orgId: string,
  subsidiaryId: string,
  consumptions: Consumption[],
  movementId: string,
  actorId: string | null,
): Promise<void> {
  for (const c of consumptions) {
    await tx.execute(sql`
      update cost_layers set remaining_quantity = remaining_quantity - ${c.quantity},
        remaining_original_cost = remaining_original_cost - ${c.originalCost ?? null}::numeric, updated_at = now(), updated_by = ${actorId}
       where id = ${c.layerId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into cost_layer_consumptions (org_id, subsidiary_id, cost_layer_id, issue_movement_id, quantity, unit_cost, original_cost, created_by, updated_by)
      values (${orgId}, ${subsidiaryId}, ${c.layerId}, ${movementId}, ${c.quantity}, ${c.unitCost}, ${c.originalCost ?? null}, ${actorId}, ${actorId})`);
  }
}

// ---------------------------------------------------------------------------
// Adjust (write-up / write-down / count correction)
// ---------------------------------------------------------------------------

/** Add exact carried value; transit positions retain each shipment's provenance. */
export async function addLayerAtCost(
  tx: Runner,
  orgId: string,
  subsidiaryId: string,
  itemId: string,
  stockLocationId: string,
  quantity: string,
  value: string,
  method: InventoryProfile["costingMethod"],
  movementId: string,
  date: string,
  actorId: string | null,
  sourceUnitCost?: string,
  originalCost: string | null = value,
): Promise<void> {
  let fragments = exactCostFragments(quantity, value, sourceUnitCost);
  let retiredLayers: {
    id: string; original_quantity: string; remaining_quantity: string; unit_cost: string;
    source_movement_id: string; received_at: string; remaining_original_cost: string | null;
  }[] = [];
  let sourceMovementId = movementId;
  let receivedAt = date;
  if (method === "moving_average") {
    // Goods in transit belong to a particular shipment. Blending them into an
    // older shipment destroys the evidence needed to receive orders out of order.
    const location = (await tx.execute<{ kind: string }>(sql`
      select kind from stock_locations where org_id=${orgId} and id=${stockLocationId} for share`)).rows[0];
    if (location?.kind !== "transit") {
      const existing = (await tx.execute<{
        id: string; original_quantity: string; remaining_quantity: string; unit_cost: string;
        source_movement_id: string; received_at: string; remaining_original_cost: string | null;
      }>(sql`
        select id, original_quantity, remaining_quantity, unit_cost, source_movement_id, received_at::text, remaining_original_cost
          from cost_layers where org_id=${orgId} and item_id=${itemId}
           and stock_location_id=${stockLocationId} and subsidiary_id=${subsidiaryId} and remaining_quantity>0
         order by received_at, created_at, id for update`)).rows;
      if (existing.length) {
        const first = existing[0]!;
        const poolQuantity = add(quantity, sum(existing.map((layer) => layer.remaining_quantity)));
        const poolValue = add(value, sum(existing.map((layer) => extendCost(layer.remaining_quantity, layer.unit_cost))));
        fragments = exactCostFragments(poolQuantity, poolValue);
        originalCost = sumOriginalCosts([originalCost, ...existing.map((layer) => layer.remaining_original_cost)]);
        sourceMovementId = first.source_movement_id;
        receivedAt = first.received_at;
        // Retire only the live basis. A partially consumed layer's rate and
        // source are historical evidence used by exact issue reversal, so it
        // must never be reused as the newly blended pool.
        retiredLayers = existing;
        for (const layer of existing) {
          await tx.execute(sql`update cost_layers
            set original_quantity=original_quantity-remaining_quantity,
                remaining_quantity='0', remaining_original_cost=case when remaining_original_cost is null then null else 0 end, updated_at=now(), updated_by=${actorId}
            where org_id=${orgId} and id=${layer.id}`);
        }
      }
    }
  }
  const createdFragments: { id: string; quantity: string; unitCost: string }[] = [];
  const bases = splitOriginalCost(originalCost, fragments.map((fragment) => fragment.quantity), fragments.map((fragment) => extendCost(fragment.quantity, fragment.unitCost)), { itemId, stockLocationId });
  for (const [index, fragment] of fragments.entries()) {
    const id = randomUUID();
    await tx.execute(sql`
      insert into cost_layers
        (id, org_id, subsidiary_id, item_id, stock_location_id, source_movement_id, received_at,
         original_quantity, remaining_quantity, unit_cost, remaining_original_cost, created_at, created_by, updated_by)
      values (${id}, ${orgId}, ${subsidiaryId}, ${itemId}, ${stockLocationId}, ${sourceMovementId}, ${receivedAt},
        ${fragment.quantity}, ${fragment.quantity}, ${fragment.unitCost}, ${bases[index]}, clock_timestamp(), ${actorId}, ${actorId})`);
    createdFragments.push({ id, ...fragment });
  }
  for (const layer of retiredLayers) {
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${orgId},'cost_layers',${layer.id},'update',${JSON.stringify({
        reason: "Re-pool remaining moving-average basis without changing historical rates",
        before: layer,
        after: { original_quantity: add(layer.original_quantity, neg(layer.remaining_quantity)), remaining_quantity: "0.0000", unit_cost: layer.unit_cost },
        sourceMovementId, incomingMovementId: movementId, quantity, value, createdFragments,
      })}::jsonb,${actorId})`);
  }
}
