import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { postLandedCostVoucher } from "./landed-cost.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

import { toUnits } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";

/** Run fn, expecting an InventoryError refusal; return it for inspection. */
async function refusalOf(fn: () => Promise<unknown>): Promise<InventoryError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof InventoryError, `expected InventoryError, got ${err}`);
    return err;
  }
  assert.fail("expected postLandedCostVoucher to refuse");
}

// Type alias (not interface): db.execute<T> constrains T to
// Record<string, unknown>, which only object-literal types satisfy.
type LayerRow = {
  id: string;
  remaining_quantity: string;
  unit_cost: string;
};

/** Open layers for one target, in allocation order. */
async function openLayers(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<LayerRow[]> {
  const r = (await db.execute<LayerRow>(sql`
    select id, remaining_quantity::text, unit_cost::text
      from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
       and stock_location_id = ${stockLocationId}
       and remaining_quantity > 0
     order by received_at, id`));
  return r.rows;
}

async function setWeight(
  orgId: string,
  actor: string,
  layerId: string,
  weight: string,
): Promise<void> {
  await db.execute(sql`
    insert into cost_layer_weights (org_id, cost_layer_id, weight, created_by, updated_by)
    values (${orgId}, ${layerId}, ${weight}, ${actor}, ${actor})`);
}

/** Counts of every table postLandedCostVoucher can write for one org. */
async function mutationSnapshot(orgId: string): Promise<Record<string, string>> {
  const r = (await db.execute<{ k: string; n: string }>(sql`
    select 'vouchers' as k, count(*)::text as n from landed_cost_vouchers where org_id = ${orgId}
     union all
    select 'targets', count(*)::text from landed_cost_voucher_targets where org_id = ${orgId}
     union all
    select 'allocations', count(*)::text from landed_cost_allocations where org_id = ${orgId}
     union all
    select 'entries', count(*)::text from journal_entries where org_id = ${orgId}
     union all
    select 'lines', count(*)::text from journal_lines where org_id = ${orgId}`));
  return Object.fromEntries(r.rows.map((row) => [row.k, row.n]));
}

async function layerSnapshot(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<string> {
  const layers = await openLayers(orgId, itemId, stockLocationId);
  return JSON.stringify(layers);
}

/** Two receipts of 10 units @ 1 → two open layers for one target. */
async function twoLayerTarget(org: ScratchOrg, actor: string): Promise<LayerRow[]> {
  await receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "1",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  await receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "1",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  const layers = await openLayers(org.orgId, org.items.fifo, org.stockLocationId);
  assert.equal(layers.length, 2);
  return layers;
}

function weightInput(org: ScratchOrg, amount = "100") {
  return {
    amount,
    basis: "weight" as const,
    freightAccountId: org.accounts.freight,
    subsidiaryId: org.subsidiaryId,
    voucherDate: org.date,
    targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  };
}

test("weight basis refuses when one open layer has no weight row, with zero mutations", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const layers = await twoLayerTarget(org, actor);
    // Base proof shape: weight 10 on the first layer only.
    await setWeight(org.orgId, actor, layers[0]!.id, "10");

    const before = await mutationSnapshot(org.orgId);
    const beforeLayers = await layerSnapshot(org.orgId, org.items.fifo, org.stockLocationId);

    const err = await refusalOf(() =>
      postLandedCostVoucher(org.orgId, actor, weightInput(org)),
    );
    assert.match(err.message, /without a weight/);
    // The refusal names the unweighted layer and the supported remedy.
    assert.match(err.message, new RegExp(layers[1]!.id.replace(/-/g, "[-]")));
    assert.match(err.message, /value, quantity, or manual/);
    assert.match(err.message, new RegExp(org.items.fifo.replace(/-/g, "[-]")));

    // The refused voucher wrote nothing: no voucher, target, allocation,
    // journal entry, or layer movement.
    assert.deepEqual(await mutationSnapshot(org.orgId), before);
    assert.equal(
      await layerSnapshot(org.orgId, org.items.fifo, org.stockLocationId),
      beforeLayers,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("weight basis apportions exactly when every open layer has a weight row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const layers = await twoLayerTarget(org, actor);
    await setWeight(org.orgId, actor, layers[0]!.id, "2");
    await setWeight(org.orgId, actor, layers[1]!.id, "3");

    const voucher = await postLandedCostVoucher(org.orgId, actor, weightInput(org));
    const allocs = (await db.execute<{ amount: string; target_cost_layer_id: string }>(sql`
      select amount::text, target_cost_layer_id
        from landed_cost_allocations
       where org_id = ${org.orgId} and voucher_id = ${voucher.id}`));
    // 10 units @ weight 2 vs 10 units @ weight 3 → 40 / 60 of 100.
    assert.equal(allocs.rows.length, 2);
    const byLayer = new Map(allocs.rows.map((r) => [r.target_cost_layer_id, toUnits(r.amount)]));
    assert.equal(byLayer.get(layers[0]!.id), toUnits("40"));
    assert.equal(byLayer.get(layers[1]!.id), toUnits("60"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("absent weight row refuses while explicit zero keeps its configured meaning", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const layers = await twoLayerTarget(org, actor);

    // All rows absent: the unconfigured-target refusal, not the zero-total
    // guard — the operator is told which layers lack weights.
    assert.match(
      (await refusalOf(() => postLandedCostVoucher(org.orgId, actor, weightInput(org)))).message,
      /without a weight/,
    );

    // All rows present but zero: every layer IS configured, so the existing
    // zero-total guard answers instead.
    for (const layer of layers) await setWeight(org.orgId, actor, layer.id, "0");
    assert.match(
      (await refusalOf(() => postLandedCostVoucher(org.orgId, actor, weightInput(org)))).message,
      /has no weight basis to apportion on/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("explicit zero weight contributes nothing; configured freight still sums exactly", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const layers = await twoLayerTarget(org, actor);
    await setWeight(org.orgId, actor, layers[0]!.id, "1");
    await setWeight(org.orgId, actor, layers[1]!.id, "0");

    // Same numbers as the base proof, but the second layer's zero is now a
    // configured row rather than an absent one — so posting 100/0 is the
    // operator's stated configuration, not a silent default.
    const voucher = await postLandedCostVoucher(org.orgId, actor, weightInput(org));
    const allocs = (await db.execute<{ amount: string; target_cost_layer_id: string }>(sql`
      select amount::text, target_cost_layer_id
        from landed_cost_allocations
       where org_id = ${org.orgId} and voucher_id = ${voucher.id}`));
    assert.equal(allocs.rows.length, 1);
    assert.equal(allocs.rows[0]!.target_cost_layer_id, layers[0]!.id);
    assert.equal(toUnits(allocs.rows[0]!.amount), toUnits("100"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multi-target weight voucher refuses atomically when any target lacks a weight", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const layersA = await twoLayerTarget(org, actor);
    for (const layer of layersA) await setWeight(org.orgId, actor, layer.id, "1");

    await receiveInventory(org.orgId, actor, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      unitCost: "2",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const layersB = await openLayers(org.orgId, org.items.component, org.stockLocationId);
    assert.equal(layersB.length, 1);

    const before = await mutationSnapshot(org.orgId);
    const err = await refusalOf(() =>
      postLandedCostVoucher(org.orgId, actor, {
        amount: "100",
        basis: "weight",
        freightAccountId: org.accounts.freight,
        subsidiaryId: org.subsidiaryId,
        voucherDate: org.date,
        targets: [
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
          { itemId: org.items.component, stockLocationId: org.stockLocationId },
        ],
      }),
    );
    assert.match(err.message, /without a weight/);
    // Names the failing target even though the first target was complete.
    assert.match(err.message, new RegExp(org.items.component.replace(/-/g, "[-]")));
    assert.match(err.message, new RegExp(layersB[0]!.id.replace(/-/g, "[-]")));
    assert.deepEqual(await mutationSnapshot(org.orgId), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
