import { consumeOriginalCost } from "./original-cost.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTransactionSavepoint } from "../platform/db.ts";
import { add, cmp, fromUnits, neg, roundDiv, toUnits } from "../money/money.ts";
import { extendCost } from "./costing.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { businessToday } from "../platform/business-date.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, inventoryOffsetAccountProblem } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency } from "./position.ts";

/**
 * Bring every open cost layer of an item onto its standard cost and post one
 * balanced revaluation entry (inventory asset vs variance account) per OWNING
 * legal entity, so issues relieve layers exactly at standard after a
 * controlled switch to standard costing — or after revising the standard cost
 * of an item already costing standard (pass `memo` to label the revision) —
 * and each entity's GL keeps equalling its own layers.
 *
 * Refuses when a nonzero variance would arise but no variance account is
 * configured: routing the delta through the asset account itself would post a
 * self-cancelling entry that leaves the GL unmoved while the layers moved —
 * a permanent, silent subledger/GL divergence. Nothing is mutated on refusal.
 * Returns one entry id per revalued entity (null when nothing needed revaluing).
 */
export async function revalueOpenLayersToStandardCost(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  itemId: string,
  p: {
    standardCost: string | null;
    assetAccountId: string;
    varianceAccountId: string | null;
    memo?: string;
    /** Interactive callers must supply their complete current subsidiary scope. */
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  },
): Promise<string[] | null> {
  // The caller owns the profile transaction and may catch this refusal.
  // Keep layer repricing and every balancing journal one indivisible operation.
  return withTransactionSavepoint(tx, async () => {
    await assertInventoryFeature(tx, orgId);
    await tx.execute(sql`select set_config('openbooks.inventory_original_cost_writer','basis-v1',true)`);
    await tx.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
    if (p.standardCost == null) {
      throw new InventoryError(
        "a standard cost must be configured before switching this item to standard costing",
      );
    }
    const layers = (await tx.execute<{
        id: string;
        subsidiary_id: string;
        stock_location_id: string;
        remaining_quantity: string;
        unit_cost: string;
        remaining_original_cost: string | null;
        evidence: string;
      }>(sql`
      select id, subsidiary_id, stock_location_id, remaining_quantity, unit_cost, remaining_original_cost,
             to_jsonb(cost_layers)::text as evidence
        from cost_layers
       where org_id = ${orgId} and item_id = ${itemId} and remaining_quantity > 0
       order by received_at, id
       for update`));
    const allowedSubsidiaryIds = p.allowedSubsidiaryIds;
    if (allowedSubsidiaryIds != null && layers.rows.some(layer => !allowedSubsidiaryIds.has(layer.subsidiary_id))) {
      throw new InventoryError("revaluation requires access to every subsidiary holding this item");
    }
    // Measure per owner AND stock location while rewriting every layer onto
    // standard cost: each position revalues into its own location-stamped
    // journal below, so location-sliced statements keep tying to the layers.
    const deltasByOwner = new Map<string, { subsidiaryId: string; stockLocationId: string; delta: bigint }>();
    for (const layer of layers.rows) {
      const delta =
        toUnits(extendCost(layer.remaining_quantity, p.standardCost)) -
        toUnits(extendCost(layer.remaining_quantity, layer.unit_cost));
      const key = `${layer.subsidiary_id} ${layer.stock_location_id}`;
      const slot = deltasByOwner.get(key) ?? { subsidiaryId: layer.subsidiary_id, stockLocationId: layer.stock_location_id, delta: 0n };
      slot.delta += delta;
      deltasByOwner.set(key, slot);
    }
    const changed = [...deltasByOwner.values()].filter((slot) => slot.delta !== 0n);
    const standardCost = p.standardCost;
    const memo = p.memo ?? "Costing method revaluation to standard";
    const repriceLayers = async () => {
      for (const layer of layers.rows) {
        // A revised policy replaces known original basis (including an old
        // NRV allowance), but never invents provenance for a legacy layer.
        const basis = layer.remaining_original_cost == null
          ? null : extendCost(layer.remaining_quantity, standardCost);
        if (cmp(layer.unit_cost, standardCost) === 0 &&
          (basis == null || cmp(basis, layer.remaining_original_cost!) === 0)) continue;
        const after = (await tx.execute<{ evidence: string }>(sql`update cost_layers
          set unit_cost=${standardCost}, remaining_original_cost=${basis},
              updated_at=now(), updated_by=${actorId}
          where org_id=${orgId} and id=${layer.id}
          returning to_jsonb(cost_layers)::text as evidence`)).rows[0]!;
        // JSON stays text between database calls so financial numbers never
        // round through JavaScript's JSON-number representation.
        // A rate change is material even when owner deltas cancel or original
        // basis remains unknown, so neither a journal nor the basis trigger
        // alone provides sufficient audit evidence.
        await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values(${orgId},'cost_layers',${layer.id},'update',jsonb_build_object(
            'reason',${memo}::text,'before',${layer.evidence}::jsonb,'after',${after.evidence}::jsonb,
            'ownerRevaluationAmount',${fromUnits(deltasByOwner.get(`${layer.subsidiary_id} ${layer.stock_location_id}`)?.delta ?? 0n)}::text
          ),${actorId})`);
      }
    };
    if (changed.length === 0) {
      // Net-zero owner balances require no journal, but heterogeneous layers
      // still need normalization before the next standard-cost issue.
      await repriceLayers();
      return null;
    }
    if (!p.varianceAccountId) {
      // Refuse BEFORE touching a single layer: with nowhere to book the
      // variance, the revaluation would post DR asset / CR asset on ONE account
      // (balanced, effectless) while the layers moved — GL and subledger would
      // diverge forever.
      throw new InventoryError(
        "revaluing open layers to standard cost requires a variance account to book the revaluation on — configure one for this item before switching it to (or revising) standard costing",
      );
    }
    const accountProblem = inventoryOffsetAccountProblem(p.assetAccountId, p.varianceAccountId, "variance");
    if (accountProblem) throw new InventoryError(accountProblem);
    const ctx = await loadSubsidiaryContext(tx, orgId);
    const accountIds = [p.assetAccountId, p.varianceAccountId];
    await tx.execute(sql`select id from accounts where org_id=${orgId}
      and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`);
    for (const slot of changed) {
      try {
        await validateSubsidiaryRestrictions(tx, {
          orgId, ctx, docSubsidiaryId: slot.subsidiaryId,
          lines: accountIds.map((accountId) => ({ accountId, subsidiaryId: slot.subsidiaryId, amount: "0" })),
        });
      } catch (error) {
        if (error instanceof SubsidiaryError) throw new InventoryError(error.message);
        throw error;
      }
    }
    const date = await businessToday(orgId);
    const periodId = await periodForDate(orgId, date, tx);
    if (!periodId) throw new InventoryError(`no accounting period for ${date}`);
    const bookId = await primaryBookId(orgId, tx);
    await repriceLayers();

    const locationDims = new Map<string, string | null>();
    const entryIds: string[] = [];
    for (const slot of changed) {
      const currency = await subsidiaryCurrency(orgId, slot.subsidiaryId, tx);
      let locationId = locationDims.get(slot.stockLocationId);
      if (locationId === undefined) {
        locationId = await stockLocationDim(tx, orgId, slot.stockLocationId, null);
        locationDims.set(slot.stockLocationId, locationId);
      }
      entryIds.push(await postInventoryEntry(tx, {
        orgId,
        bookId,
        subsidiaryId: slot.subsidiaryId,
        actorId,
        currency,
        periodId,
        date,
        entryNumber: `INV-RCST-${date}-${itemId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
        memo,
        lines: [
          { accountId: p.assetAccountId, amount: fromUnits(slot.delta), locationId, memo },
          {
            accountId: p.varianceAccountId,
            amount: fromUnits(-slot.delta),
            locationId,
            memo,
          },
        ],
      }));
    }
    return entryIds;
  });
}

// ---------------------------------------------------------------------------
// Landed cost (allocate freight/duty onto receipt layers)
// ---------------------------------------------------------------------------
export type RevaluableLayer = {
  remaining_original_cost: string | null;
  id: string;
  subsidiary_id: string;
  source_movement_id: string;
  received_at: string;
  original_quantity: string;
  remaining_quantity: string;
  unit_cost: string;
};

/**
 * Increase one layer's remaining value by exactly `shareUnits`.
 *
 * Unit costs are stored at four decimals. A naïve average-cost bump therefore
 * loses pennies whenever quantity does not divide the allocation exactly
 * (three units + $0.01 used to add only $0.0099 to the subledger while the GL
 * added $0.0100). For quantities above one unit, keep an average bump on the
 * main layer and split one whole unit into a deterministic rounding layer.
 * One unit has a 1:1 mapping between rate units and value units, so the
 * residual is always representable without floating point or an off-ledger
 * plug. The split preserves the pre-allocation value exactly.
 */
export async function revalueLayerExactly(
  tx: Runner,
  orgId: string,
  layer: RevaluableLayer,
  shareUnits: bigint,
  actorId: string | null,
  allowLayerSplit = true,
): Promise<{ layerId: string; amount: string }[]> {
  if (shareUnits <= 0n) return [];
  const scale = 10_000n;
  const quantityUnits = toUnits(layer.remaining_quantity);
  const oldRateUnits = toUnits(layer.unit_cost);
  if (quantityUnits <= 0n) {
    throw new InventoryError("cannot revalue an empty inventory layer");
  }
  const valueAt = (quantity: bigint, rate: bigint) =>
    roundDiv(quantity * rate, scale);

  const targetValue = valueAt(quantityUnits, oldRateUnits) + shareUnits;
  const findExactRate = (): bigint | null => {
    let low = oldRateUnits;
    let high =
      (targetValue * scale + quantityUnits - 1n) / quantityUnits + 2n;
    if (high < low) high = low;
    while (valueAt(quantityUnits, high) < targetValue) {
      high = high * 2n + 1n;
    }
    while (low < high) {
      const mid = (low + high) / 2n;
      if (valueAt(quantityUnits, mid) < targetValue) low = mid + 1n;
      else high = mid;
    }
    return valueAt(quantityUnits, low) === targetValue ? low : null;
  };
  const exactRate = findExactRate();
  if (exactRate != null) {
    await tx.execute(sql`
      update cost_layers
         set unit_cost = ${fromUnits(exactRate)}, remaining_original_cost = remaining_original_cost + ${fromUnits(shareUnits)}::numeric, updated_at = now(), updated_by = ${actorId}
       where id = ${layer.id} and org_id = ${orgId}
    `);
    return [{ layerId: layer.id, amount: fromUnits(shareUnits) }];
  }
  if (!allowLayerSplit) {
    throw new InventoryError(
      "landed cost is not exactly representable on a moving-average layer at current precision",
    );
  }

  const roundingQuantityUnits = scale; // exactly one base unit
  const mainQuantityUnits = quantityUnits - roundingQuantityUnits;
  const mainOldValue = valueAt(mainQuantityUnits, oldRateUnits);
  let mainRateUnits =
    oldRateUnits + (shareUnits * scale) / quantityUnits;
  let mainDelta =
    valueAt(mainQuantityUnits, mainRateUnits) - mainOldValue;
  while (mainDelta > shareUnits && mainRateUnits > oldRateUnits) {
    mainRateUnits -= 1n;
    mainDelta = valueAt(mainQuantityUnits, mainRateUnits) - mainOldValue;
  }
  if (mainDelta < 0n || mainDelta > shareUnits) {
    throw new InventoryError(
      "landed-cost allocation produced an invalid layer delta",
    );
  }
  const roundingDelta = shareUnits - mainDelta;
  const roundingRateUnits = oldRateUnits + roundingDelta;
  const splitLayerId = randomUUID();
  const splitBasis = consumeOriginalCost(layer.remaining_original_cost, "1", layer.remaining_quantity);
  const mainBasis = layer.remaining_original_cost == null || splitBasis == null ? null
    : add(add(layer.remaining_original_cost, neg(splitBasis)), fromUnits(mainDelta));
  const roundingBasis = splitBasis == null ? null : add(splitBasis, fromUnits(roundingDelta));

  await tx.execute(sql`
    update cost_layers
       set original_quantity = original_quantity - '1.0000',
           remaining_quantity = remaining_quantity - '1.0000',
           unit_cost = ${fromUnits(mainRateUnits)}, remaining_original_cost = ${mainBasis},
           updated_at = now(),
           updated_by = ${actorId}
     where id = ${layer.id} and org_id = ${orgId}
  `);
  await tx.execute(sql`
    insert into cost_layers
      (id, org_id, subsidiary_id, item_id, stock_location_id, source_movement_id, received_at,
       original_quantity, remaining_quantity, unit_cost, remaining_original_cost, created_at, created_by, updated_by)
    select ${splitLayerId}, org_id, subsidiary_id, item_id, stock_location_id,
           ${layer.source_movement_id}, ${layer.received_at},
           '1.0000', '1.0000', ${fromUnits(roundingRateUnits)}, ${roundingBasis}, clock_timestamp(),
           ${actorId}, ${actorId}
      from cost_layers
     where id = ${layer.id} and org_id = ${orgId}
  `);

  const fragments: { layerId: string; amount: string }[] = [];
  if (mainDelta > 0n) {
    fragments.push({ layerId: layer.id, amount: fromUnits(mainDelta) });
  }
  if (roundingDelta > 0n) {
    fragments.push({
      layerId: splitLayerId,
      amount: fromUnits(roundingDelta),
    });
  }
  return fragments;
}

/** Remove an exact landed-cost fragment from an untouched layer. */
export async function devalueLayerExactly(
  tx: Runner,
  orgId: string,
  layer: RevaluableLayer,
  amountUnits: bigint,
  actorId: string,
): Promise<void> {
  if (amountUnits <= 0n) {
    throw new InventoryError("landed-cost reversal amount must be positive");
  }
  const scale = 10_000n;
  const quantityUnits = toUnits(layer.remaining_quantity);
  const currentRateUnits = toUnits(layer.unit_cost);
  if (
    quantityUnits <= 0n ||
    cmp(layer.remaining_quantity, layer.original_quantity) !== 0
  ) {
    throw new InventoryError(
      "landed cost cannot be reversed after its layer has been consumed",
    );
  }
  const valueAt = (quantity: bigint, rate: bigint) =>
    roundDiv(quantity * rate, scale);
  const currentValue = valueAt(quantityUnits, currentRateUnits);
  const targetValue = currentValue - amountUnits;
  if (targetValue < 0n) {
    throw new InventoryError(
      "landed-cost reversal would make the layer value negative",
    );
  }
  let low = 0n;
  let high = currentRateUnits;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (valueAt(quantityUnits, mid) < targetValue) low = mid + 1n;
    else high = mid;
  }
  if (valueAt(quantityUnits, low) !== targetValue) {
    throw new InventoryError(
      "landed-cost reversal is not exactly representable at ledger precision",
    );
  }
  await tx.execute(sql`
    update cost_layers
       set unit_cost = ${fromUnits(low)}, remaining_original_cost = remaining_original_cost - ${fromUnits(amountUnits)}::numeric, updated_at = now(), updated_by = ${actorId}
     where id = ${layer.id} and org_id = ${orgId}
  `);
}

/** Largest-remainder apportionment of money units across numeric weights. */
export function apportionUnits(totalUnits: bigint, weights: string[]): bigint[] {
  const iw = weights.map((weight) => {
    const units = toUnits(weight);
    return units > 0n ? units : 0n;
  });
  const iwsum = iw.reduce((a, b) => a + b, 0n);
  if (iwsum === 0n || totalUnits === 0n) return weights.map(() => 0n);
  const base = iw.map((w) => (totalUnits * w) / iwsum);
  let remainder = totalUnits - base.reduce((a, b) => a + b, 0n);
  const order = iw
    .map((w, i) => ({ i, frac: (totalUnits * w) % iwsum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length]!.i]! += 1n;
    remainder -= 1n;
    k++;
  }
  return base;
}
