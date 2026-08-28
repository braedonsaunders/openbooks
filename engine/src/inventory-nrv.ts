import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { fromUnits, mul, roundDiv, toUnits } from "./money.ts";
import { getOnHandForEntity, postInventoryEntry } from "./inventory.ts";
import { orgReportingFramework, type ReportingFramework } from "./reporting-framework.ts";

/**
 * Lower of cost and net realisable value — IAS 2.28-33 / ASC 330-10-35.
 *
 * A write-down remeasures VALUE ONLY. On-hand quantity never changes: the
 * remaining cost layers are revalued downward so their carrying amount equals
 * net realisable value, and the loss posts immediately (DR inventory
 * adjustment / CR inventory asset). Future issues then consume the written-
 * down cost — the new basis flows through cost of sales on its own.
 *
 * Reversal is a FRAMEWORK question answered by configuration, not code:
 *  - IFRS (IAS 2.33): a later recovery reverses the write-down. Cumulative
 *    reversals are capped at the cumulative write-down for the item/location,
 *    so this path can never carry inventory above original cost.
 *  - US GAAP (ASC 330-10-35-14): the written-down amount is a new cost basis;
 *    reversal is refused.
 *
 * Both movements post through the same inventory GL path as every other
 * inventory value change and leave an `inventory_writedowns` evidence row.
 */

export class InventoryNrvError extends Error {
  readonly name = "InventoryNrvError";
}

const SCALE = 10_000n;
const valueAt = (quantityUnits: bigint, rateUnits: bigint): bigint =>
  roundDiv(quantityUnits * rateUnits, SCALE);
type RemainingLayer = {
  id: string;
  subsidiary_id: string;
  source_movement_id: string;
  received_at: string;
  remaining_quantity: string;
  unit_cost: string;
  source_kind: string | null;
  source_status: string | null;
  source_unit_cost: string | null;
};

/** Inbound movements that can authoritatively seed a cost layer. */
const SUPPORTED_INBOUND_LAYER_KINDS = new Set([
  "receipt",
  "return",
  "transfer_in",
  "assembly_build",
]);

/**
 * Set one layer's remaining value to exactly `targetUnits` (4dp money units).
 *
 * Same exactness discipline as the landed-cost allocator, generalised to work
 * in BOTH directions: binary-search a 4dp unit cost whose extended value hits
 * the target exactly; when no such rate exists and the layer holds more than
 * one unit, split a single unit into a deterministic rounding layer (one unit
 * maps rate units to value units 1:1, so any residual is representable).
 */
async function setLayerValueExactly(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  layer: RemainingLayer,
  targetUnits: bigint,
  actorId: string | null,
  respectSourceCeiling = false,
): Promise<void> {
  const quantityUnits = toUnits(layer.remaining_quantity);
  if (quantityUnits <= 0n) throw new InventoryNrvError("cannot revalue an empty layer");
  if (targetUnits < 0n) throw new InventoryNrvError("layer value cannot go negative");

  const findExactRate = (): bigint | null => {
    let low = 0n;
    let high = (targetUnits * SCALE) / quantityUnits + 2n;
    while (valueAt(quantityUnits, high) < targetUnits) high = high * 2n + 1n;
    while (low < high) {
      const mid = (low + high) / 2n;
      if (valueAt(quantityUnits, mid) < targetUnits) low = mid + 1n;
      else high = mid;
    }
    return valueAt(quantityUnits, low) === targetUnits ? low : null;
  };

  const exactRate = findExactRate();
  if (exactRate != null) {
    await tx.execute(sql`
      update cost_layers
         set unit_cost = ${fromUnits(exactRate)}, updated_at = now(), updated_by = ${actorId}
       where id = ${layer.id} and org_id = ${orgId}`);
    return;
  }

  if (quantityUnits <= SCALE) {
    // Exactly one unit (or a fraction) always has an exact rate; reaching here
    // means the target is unrepresentable — a logic error, not a data state.
    throw new InventoryNrvError("layer value not representable at 4dp precision");
  }

  // Split one whole unit off as the rounding layer.
  const mainQuantityUnits = quantityUnits - SCALE;
  let mainRate = (targetUnits * SCALE) / quantityUnits;
  let mainValue = valueAt(mainQuantityUnits, mainRate);
  while (mainValue > targetUnits && mainRate > 0n) {
    mainRate -= 1n;
    mainValue = valueAt(mainQuantityUnits, mainRate);
  }
  // Keep both fragments at or below the immutable source rate when this is a
  // reversal. A floor average can leave a one-unit residual just above source
  // cost because of four-decimal multiplication rounding (for example,
  // 3 × 1.0001 with a 3.0002 target). Move the main fragment up, while still
  // below the target, until the residual has the same ceiling.
  const sourceRate =
    respectSourceCeiling && layer.source_unit_cost != null
      ? toUnits(layer.source_unit_cost)
      : null;
  if (sourceRate != null) {
    while (mainValue < targetUnits - sourceRate && mainRate < sourceRate) {
      mainRate += 1n;
      mainValue = valueAt(mainQuantityUnits, mainRate);
    }
    if (mainValue > targetUnits) {
      while (mainValue > targetUnits && mainRate > 0n) {
        mainRate -= 1n;
        mainValue = valueAt(mainQuantityUnits, mainRate);
      }
    }
  }
  const roundingValue = targetUnits - mainValue;
  if (roundingValue < 0n) throw new InventoryNrvError("NRV remeasurement produced an invalid layer split");
  if (sourceRate != null && roundingValue > sourceRate) {
    throw new InventoryNrvError("NRV remeasurement exceeded an inventory layer's original source cost");
  }

  const splitLayerId = randomUUID();
  await tx.execute(sql`
    update cost_layers
       set original_quantity = original_quantity - '1.0000',
           remaining_quantity = remaining_quantity - '1.0000',
           unit_cost = ${fromUnits(mainRate)},
           updated_at = now(), updated_by = ${actorId}
     where id = ${layer.id} and org_id = ${orgId}`);
  await tx.execute(sql`
    insert into cost_layers
      (id, org_id, subsidiary_id, item_id, stock_location_id, source_movement_id, received_at,
       original_quantity, remaining_quantity, unit_cost, created_by, updated_by)
    select ${splitLayerId}, org_id, subsidiary_id, item_id, stock_location_id,
           ${layer.source_movement_id}, ${layer.received_at},
           '1.0000', '1.0000', ${fromUnits(roundingValue)}, ${actorId}, ${actorId}
      from cost_layers
     where id = ${layer.id} and org_id = ${orgId}`);
}

/** Distribute a total value change across layers in proportion to value. */
function shareByValue(layers: { value: bigint }[], deltaUnits: bigint): bigint[] {
  const weights = layers.map((l) => l.value);
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total <= 0n) throw new InventoryNrvError("no remaining inventory value to remeasure");
  const magnitude = deltaUnits < 0n ? -deltaUnits : deltaUnits;
  const base = weights.map((w) => (magnitude * w) / total);
  let remainder = magnitude - base.reduce((a, b) => a + b, 0n);
  // Largest-remainder assignment, stable by index.
  const order = weights
    .map((w, i) => ({ i, w, frac: (magnitude * w) % total }))
    .filter((entry) => entry.w > 0n)
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length]!.i]! += 1n;
    remainder -= 1n;
    k++;
  }
  return base.map((b) => (deltaUnits < 0n ? -b : b));
}

/**
 * Allocate a positive reversal only across each layer's available original-
 * cost headroom. The bigint largest-remainder arithmetic is deterministic and
 * returns shares whose sum is exactly `deltaUnits`.
 */
function shareByHeadroom(headrooms: bigint[], deltaUnits: bigint): bigint[] {
  if (deltaUnits < 0n) throw new InventoryNrvError("reversal allocation cannot be negative");
  const total = headrooms.reduce((a, b) => a + b, 0n);
  if (total <= 0n) throw new InventoryNrvError("no remaining layer headroom to remeasure");
  if (deltaUnits > total) throw new InventoryNrvError("reversal exceeds remaining layer headroom");

  const shares = headrooms.map((headroom) => (deltaUnits * headroom) / total);
  let remainder = deltaUnits - shares.reduce((a, b) => a + b, 0n);
  const order = headrooms
    .map((headroom, i) => ({ i, headroom, frac: (deltaUnits * headroom) % total }))
    .filter((entry) => entry.headroom > 0n)
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    shares[order[k % order.length]!.i]! += 1n;
    remainder -= 1n;
    k++;
  }
  return shares;
}

async function remainingLayers(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId?: string,
): Promise<RemainingLayer[]> {
  const ownerScope = subsidiaryId ? sql`and layer.subsidiary_id = ${subsidiaryId}` : sql``;
  const r = (await tx.execute<RemainingLayer>(sql`
    select layer.id, layer.subsidiary_id, layer.source_movement_id,
           layer.received_at::text as received_at,
           layer.remaining_quantity::text as remaining_quantity,
           layer.unit_cost::text as unit_cost,
           source.kind as source_kind, source.status as source_status,
           source.unit_cost::text as source_unit_cost
      from cost_layers layer
      left join inventory_movements source
        on source.id = layer.source_movement_id and source.org_id = layer.org_id
     where layer.org_id = ${orgId} and layer.item_id = ${itemId}
       and layer.stock_location_id = ${stockLocationId}
       ${ownerScope}
       and layer.remaining_quantity > 0
     order by layer.received_at, layer.id
     for update of layer`));
  return r.rows;
}

async function itemAccounts(orgId: string, itemId: string): Promise<{ asset: string; adjustment: string }> {
  const r = (await db.execute<{ asset_account_id: string; adjustment_account_id: string }>(sql`
    select asset_account_id, coalesce(adjustment_account_id, cogs_account_id) as adjustment_account_id
      from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}`));
  const row = r.rows[0];
  if (!row) throw new InventoryNrvError("item has no inventory profile");
  return { asset: row.asset_account_id, adjustment: row.adjustment_account_id };
}

async function postingContext(orgId: string, subsidiaryId: string, date: string) {
  const r = (await db.execute<{ book_id: string | null; period_id: string | null; currency: string | null }>(sql`
    select (select id from accounting_books where org_id = ${orgId} and is_primary limit 1) as book_id,
           (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
              and starts_on <= ${date} and ends_on >= ${date} limit 1) as period_id,
           (select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}) as currency
  `));
  const row = r.rows[0];
  if (!row?.book_id) throw new InventoryNrvError("no primary accounting book");
  if (!row.period_id) throw new InventoryNrvError(`no accounting period covers ${date}`);
  if (!row.currency) throw new InventoryNrvError("subsidiary not found");
  return { bookId: row.book_id, periodId: row.period_id, currency: row.currency };
}

export interface NrvWritedownInput {
  itemId: string;
  stockLocationId: string;
  /**
   * The requesting entity. Revaluation follows LAYER OWNERSHIP: every legal
   * entity holding the position is remeasured and journals under itself.
   */
  subsidiaryId: string;
  date: string;
  /** Net realisable value PER UNIT. The target carrying amount is qty × NRV. */
  nrvPerUnit: string;
  memo?: string | null;
}

/** One owning entity's share of a remeasurement, with its own evidence ids. */
export interface NrvEntityPosting {
  subsidiaryId: string;
  writedownId: string;
  entryId: string;
  previousValue: string;
  newValue: string;
  amount: string;
}

export interface NrvResult {
  writedownId: string;
  entryId: string;
  quantity: string;
  previousValue: string;
  newValue: string;
  amount: string;
  framework: ReportingFramework;
  /**
   * One record per owning legal entity remeasured. `writedownId`/`entryId`
   * above are the FIRST posting's evidence; the array carries every owner's.
   */
  entities: NrvEntityPosting[];
}

/**
 * Write inventory down to net realisable value. Value-only: quantity is
 * untouched. Refuses a "write-down" whose target is at or above current cost —
 * that is either a no-op or a reversal, and reversals have their own rules.
 *
 * A shared warehouse can hold the item's layers under several legal entities.
 * Each owner is measured on ITS OWN quantity and carrying amount, only its
 * layers are re-written, and its loss journals under ITSELF — one set of
 * layer writes plus one journal per entity — so per-entity GL always equals
 * per-entity layers.
 */
export async function writeDownInventoryToNrv(
  orgId: string,
  actorId: string | null,
  input: NrvWritedownInput,
): Promise<NrvResult> {
  const framework = await orgReportingFramework(orgId);
  const accounts = await itemAccounts(orgId, input.itemId);

  return await db.transaction(async (tx) => {
    const layers = await remainingLayers(tx, orgId, input.itemId, input.stockLocationId);
    if (layers.length === 0) throw new InventoryNrvError("nothing on hand to write down");

    // Group the locked layers by owning legal entity, first-seen order.
    const owners: { subsidiaryId: string; layers: RemainingLayer[] }[] = [];
    const byOwner = new Map<string, RemainingLayer[]>();
    for (const layer of layers) {
      let group = byOwner.get(layer.subsidiary_id);
      if (!group) {
        group = [];
        byOwner.set(layer.subsidiary_id, group);
        owners.push({ subsidiaryId: layer.subsidiary_id, layers: group });
      }
      group.push(layer);
    }

    // Measure each owner separately: an entity is written down only when ITS
    // carrying amount exceeds ITS quantity × NRV.
    type OwnerPlan = (typeof owners)[number] & {
      quantityUnits: bigint;
      previousUnits: bigint;
      targetUnits: bigint;
      deltaUnits: bigint;
    };
    const plans: OwnerPlan[] = [];
    for (const owner of owners) {
      const onHand = await getOnHandForEntity(
        tx,
        orgId,
        input.itemId,
        input.stockLocationId,
        owner.subsidiaryId,
      );
      const previousUnits = toUnits(onHand.value);
      const targetUnits = toUnits(mul(onHand.quantity, input.nrvPerUnit));
      const deltaUnits = targetUnits - previousUnits;
      if (deltaUnits < 0n) {
        plans.push({
          ...owner,
          quantityUnits: toUnits(onHand.quantity),
          previousUnits,
          targetUnits,
          deltaUnits,
        });
      }
    }
    if (plans.length === 0) {
      throw new InventoryNrvError(
        "net realisable value is not below cost — nothing to write down (a recovery is a reversal, not a write-down)",
      );
    }

    let totalQuantityUnits = 0n;
    let totalPreviousUnits = 0n;
    let totalTargetUnits = 0n;
    const entities: NrvEntityPosting[] = [];
    for (const plan of plans) {
      const enriched = plan.layers.map((layer) => ({
        layer,
        value: valueAt(toUnits(layer.remaining_quantity), toUnits(layer.unit_cost)),
      }));
      const shares = shareByValue(enriched, plan.deltaUnits);
      for (let i = 0; i < enriched.length; i++) {
        await setLayerValueExactly(tx, orgId, enriched[i]!.layer, enriched[i]!.value + shares[i]!, actorId);
      }

      const ctx = await postingContext(orgId, plan.subsidiaryId, input.date);
      const amount = fromUnits(-plan.deltaUnits);
      const memo = input.memo ?? `NRV write-down — carrying value to ${fromUnits(plan.targetUnits)}`;
      const entryId = await postInventoryEntry(tx, {
        orgId,
        bookId: ctx.bookId,
        subsidiaryId: plan.subsidiaryId,
        currency: ctx.currency,
        periodId: ctx.periodId,
        date: input.date,
        entryNumber: `NRV-${randomUUID().slice(0, 8)}`,
        memo,
        lines: [
          { accountId: accounts.adjustment, amount, memo },
          { accountId: accounts.asset, amount: fromUnits(plan.deltaUnits), memo },
        ],
      });

      const writedownId = randomUUID();
      await tx.execute(sql`
        insert into inventory_writedowns
          (id, org_id, item_id, stock_location_id, subsidiary_id, kind, date, quantity,
           previous_value, new_value, amount, reversed_amount, framework, journal_entry_id, memo,
           created_by, updated_by)
        values (${writedownId}, ${orgId}, ${input.itemId}, ${input.stockLocationId}, ${plan.subsidiaryId},
                'writedown', ${input.date}, ${fromUnits(plan.quantityUnits)}, ${fromUnits(plan.previousUnits)},
                ${fromUnits(plan.targetUnits)}, ${amount}, '0', ${framework}, ${entryId}, ${memo},
                ${actorId}, ${actorId})`);

      totalQuantityUnits += plan.quantityUnits;
      totalPreviousUnits += plan.previousUnits;
      totalTargetUnits += plan.targetUnits;
      entities.push({
        subsidiaryId: plan.subsidiaryId,
        writedownId,
        entryId,
        previousValue: fromUnits(plan.previousUnits),
        newValue: fromUnits(plan.targetUnits),
        amount,
      });
    }

    return {
      writedownId: entities[0]!.writedownId,
      entryId: entities[0]!.entryId,
      quantity: fromUnits(totalQuantityUnits),
      previousValue: fromUnits(totalPreviousUnits),
      newValue: fromUnits(totalTargetUnits),
      // Positive write-down magnitude, matching each entity posting.
      amount: fromUnits(totalPreviousUnits - totalTargetUnits),
      framework,
      entities,
    };
  });
}

export interface NrvReversalInput {
  itemId: string;
  stockLocationId: string;
  /** The recovering legal entity — only ITS layers and write-downs are touched. */
  subsidiaryId: string;
  date: string;
  /** Revised net realisable value PER UNIT. */
  nrvPerUnit: string;
  memo?: string | null;
}

/**
 * Reverse a prior write-down after NRV recovers — IFRS only.
 *
 * US GAAP treats the written-down amount as a new cost basis
 * (ASC 330-10-35-14) and this function refuses under that framework.
 *
 * The IAS 2.33 cap: the increase is limited BOTH by the revised NRV target and
 * by the unreversed remainder of THIS entity's prior write-downs for the
 * quantity that is still on hand. Issues consume the written-down layers but
 * do not mutate the evidence row, so applying the whole historical remainder
 * after an issue could restore value belonging to units that have already
 * been sold. Layers, open write-downs, and the journal are all scoped to the
 * requesting entity, so one owner's recovery never releases another's.
 */
export async function reverseInventoryWritedown(
  orgId: string,
  actorId: string | null,
  input: NrvReversalInput,
): Promise<NrvResult> {
  const framework = await orgReportingFramework(orgId);
  if (framework !== "ifrs") {
    throw new InventoryNrvError(
      "write-down reversal is prohibited under US GAAP (ASC 330-10-35-14): the written-down amount is the new cost basis",
    );
  }
  const accounts = await itemAccounts(orgId, input.itemId);
  const ctx = await postingContext(orgId, input.subsidiaryId, input.date);

  return await db.transaction(async (tx) => {
    const layers = await remainingLayers(
      tx,
      orgId,
      input.itemId,
      input.stockLocationId,
      input.subsidiaryId,
    );
    if (layers.length === 0) throw new InventoryNrvError("nothing on hand to remeasure");

    const open = (await tx.execute<{ id: string; quantity: string; remaining: string }>(sql`
      select id, quantity::text as quantity, (amount - reversed_amount)::text as remaining
        from inventory_writedowns
       where org_id = ${orgId} and item_id = ${input.itemId}
         and stock_location_id = ${input.stockLocationId}
         and subsidiary_id = ${input.subsidiaryId}
         and kind = 'writedown' and amount > reversed_amount
       order by date, created_at
       for update`));
    const totalReversible = open.rows.reduce((a, r) => a + toUnits(r.remaining), 0n);
    if (totalReversible <= 0n) {
      throw new InventoryNrvError(
        "no unreversed write-down exists for this item, location, and legal entity",
      );
    }

    const onHand = await getOnHandForEntity(
      tx,
      orgId,
      input.itemId,
      input.stockLocationId,
      input.subsidiaryId,
    );
    const previousUnits = toUnits(onHand.value);
    const targetByNrv = toUnits(mul(onHand.quantity, input.nrvPerUnit));
    const requested = targetByNrv - previousUnits;
    if (requested <= 0n) {
      throw new InventoryNrvError("revised net realisable value is not above the carrying amount — nothing to reverse");
    }
    // IAS 2.33 cap: an issue consumes the written-down cost layer, but the
    // historical evidence row remains open. Allocate each row's unreversed
    // amount only to the quantity that survives on hand; otherwise a write-down
    // on 10 units followed by an issue of 9 could release the full 10-unit loss
    // onto the one unit left in inventory.
    const onHandQuantityUnits = toUnits(onHand.quantity);
    const reversibleForOnHand = open.rows.reduce((total, row) => {
      const rowQuantityUnits = toUnits(row.quantity);
      if (rowQuantityUnits <= 0n) return total;
      const survivingQuantityUnits =
        onHandQuantityUnits < rowQuantityUnits ? onHandQuantityUnits : rowQuantityUnits;
      return total + (toUnits(row.remaining) * survivingQuantityUnits) / rowQuantityUnits;
    }, 0n);
    // Every remaining layer must carry immutable provenance for its original
    // cost ceiling. A position-wide source-cost total is insufficient: it can
    // spend a cheap layer's headroom on a fresh, already-at-cost receipt.
    // Supported inbound movement kinds all persist their original unit_cost;
    // anything else (or a missing source row/cost) fails closed.
    const enriched = layers.map((layer) => {
      if (
        layer.source_kind == null ||
        layer.source_status !== "posted" ||
        !SUPPORTED_INBOUND_LAYER_KINDS.has(layer.source_kind) ||
        layer.source_unit_cost == null
      ) {
        throw new InventoryNrvError(
          "inventory layer original-cost provenance is unavailable; reversal is refused",
        );
      }
      const originalRateUnits = toUnits(layer.source_unit_cost);
      if (originalRateUnits < 0n) {
        throw new InventoryNrvError(
          "inventory layer original-cost provenance is invalid; reversal is refused",
        );
      }
      const value = valueAt(toUnits(layer.remaining_quantity), toUnits(layer.unit_cost));
      const originalValue = valueAt(toUnits(layer.remaining_quantity), originalRateUnits);
      const headroom = originalValue > value ? originalValue - value : 0n;
      return { layer, value, headroom };
    });
    const layerHeadroom = enriched.reduce((total, layer) => total + layer.headroom, 0n);
    const increaseCap = [totalReversible, reversibleForOnHand, layerHeadroom].reduce(
      (cap, candidate) => (candidate < cap ? candidate : cap),
    );
    const increase = requested < increaseCap ? requested : increaseCap;
    if (increase <= 0n) {
      throw new InventoryNrvError(
        "no unreversed write-down remains within original cost of inventory still on hand",
      );
    }
    const targetUnits = previousUnits + increase;

    const shares = shareByHeadroom(
      enriched.map((layer) => layer.headroom),
      increase,
    );
    for (let i = 0; i < enriched.length; i++) {
      await setLayerValueExactly(
        tx,
        orgId,
        enriched[i]!.layer,
        enriched[i]!.value + shares[i]!,
        actorId,
        true,
      );
    }

    // Consume the open write-downs oldest-first.
    let toConsume = increase;
    let lastWritedownId: string | null = null;
    for (const row of open.rows) {
      if (toConsume <= 0n) break;
      const remaining = toUnits(row.remaining);
      const take = remaining < toConsume ? remaining : toConsume;
      await tx.execute(sql`
        update inventory_writedowns
           set reversed_amount = reversed_amount + ${fromUnits(take)},
               updated_at = now(), updated_by = ${actorId}
         where id = ${row.id} and org_id = ${orgId}`);
      toConsume -= take;
      lastWritedownId = row.id;
    }

    const amount = fromUnits(increase);
    const memo = input.memo ?? `NRV write-down reversal — carrying value to ${fromUnits(targetUnits)}`;
    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId: ctx.bookId,
      subsidiaryId: input.subsidiaryId,
      currency: ctx.currency,
      periodId: ctx.periodId,
      date: input.date,
      entryNumber: `NRVR-${randomUUID().slice(0, 8)}`,
      memo,
      lines: [
        { accountId: accounts.asset, amount, memo },
        { accountId: accounts.adjustment, amount: fromUnits(-increase), memo },
      ],
    });

    const reversalId = randomUUID();
    await tx.execute(sql`
      insert into inventory_writedowns
        (id, org_id, item_id, stock_location_id, subsidiary_id, kind, date, quantity,
         previous_value, new_value, amount, reversed_amount, reverses_writedown_id, framework,
         journal_entry_id, memo, created_by, updated_by)
      values (${reversalId}, ${orgId}, ${input.itemId}, ${input.stockLocationId}, ${input.subsidiaryId},
              'reversal', ${input.date}, ${onHand.quantity}, ${fromUnits(previousUnits)},
              ${fromUnits(targetUnits)}, ${amount}, ${amount}, ${lastWritedownId}, ${framework},
              ${entryId}, ${memo}, ${actorId}, ${actorId})`);

    return {
      writedownId: reversalId,
      entryId,
      quantity: onHand.quantity,
      previousValue: fromUnits(previousUnits),
      newValue: fromUnits(targetUnits),
      amount,
      framework,
      // A reversal remeasures exactly one owner — the requesting entity.
      entities: [
        {
          subsidiaryId: input.subsidiaryId,
          writedownId: reversalId,
          entryId,
          previousValue: fromUnits(previousUnits),
          newValue: fromUnits(targetUnits),
          amount,
        },
      ],
    };
  });
}
