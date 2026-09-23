import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, env } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory, issueInventory, adjustInventory } from "./movements.ts";
import { transferInventory } from "./transfers.ts";
import { reverseInventoryMovement } from "./reversal.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * INV-ACTIVE: every movement-creating path fences inactive items (the IN1
 * assembly fence, generalized). Receiving, issuing, adjusting, or
 * transferring an inactive item refuses by name inside the posting
 * transaction — before any movement, layer, or journal write — and a
 * deactivation racing a posting serializes to exactly one outcome.
 * Controlled unwinds (reversals) stay possible after deactivation.
 */

async function deactivateItem(orgId: string, itemId: string): Promise<void> {
  const r = await db.execute<{ id: string }>(sql`
    update items set is_active = false, updated_at = now()
     where org_id = ${orgId} and id = ${itemId}
    returning id`);
  assert.equal(r.rows.length, 1, "deactivation must match exactly one row");
}

async function postedCounts(orgId: string): Promise<{ movements: number; entries: number; layers: number }> {
  return (await db.execute<{ movements: number; entries: number; layers: number }>(sql`
    select (select count(*)::int from inventory_movements where org_id = ${orgId}) as movements,
           (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
           (select count(*)::int from cost_layers where org_id = ${orgId}) as layers
  `)).rows[0]!;
}

async function receiveWhileActive(org: ScratchOrg, quantity = "10"): Promise<string> {
  const posted = await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity,
    unitCost: "1",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  return posted.movementId;
}

function expectInactiveRefusal(itemName: string) {
  return (e: unknown) => {
    assert.ok(e instanceof InventoryError, "inactive posting must refuse as InventoryError (HTTP 422)");
    assert.match((e as Error).message, new RegExp(itemName), "the refusal must name the item");
    assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
    assert.match(
      (e as Error).message,
      /reactivate it before posting stock movements/,
      "the refusal must name the remedy",
    );
    return true;
  };
}

test("receiving an inactive item is refused by name with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await deactivateItem(org.orgId, org.items.fifo);
    const before = await postedCounts(org.orgId);
    await assert.rejects(
      receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "4",
        unitCost: "1",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
      expectInactiveRefusal("FIFO Widget"),
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId),
      { quantity: "0.0000", value: "0.0000", unitCost: "0" },
      "no stock may be minted",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("issuing an inactive item is refused by name with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveWhileActive(org);
    await deactivateItem(org.orgId, org.items.fifo);
    const before = await postedCounts(org.orgId);
    const onHandBefore = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    await assert.rejects(
      issueInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "2",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      expectInactiveRefusal("FIFO Widget"),
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer change may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId),
      onHandBefore,
      "no stock may be consumed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("transferring an inactive item is refused by name with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveWhileActive(org);
    await deactivateItem(org.orgId, org.items.fifo);
    const before = await postedCounts(org.orgId);
    const sourceBefore = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    await assert.rejects(
      transferInventory(org.orgId, null, {
        itemId: org.items.fifo,
        fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2,
        quantity: "3",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      expectInactiveRefusal("FIFO Widget"),
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer change may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId),
      sourceBefore,
      "no stock may leave the source",
    );
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2),
      { quantity: "0.0000", value: "0.0000", unitCost: "0" },
      "no stock may arrive at the destination",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("adjusting an inactive item is refused by name in both directions", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveWhileActive(org);
    await deactivateItem(org.orgId, org.items.fifo);
    const before = await postedCounts(org.orgId);
    const onHandBefore = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    await assert.rejects(
      adjustInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantityDelta: "5",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      expectInactiveRefusal("FIFO Widget"),
    );
    await assert.rejects(
      adjustInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantityDelta: "-2",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      expectInactiveRefusal("FIFO Widget"),
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer change may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId),
      onHandBefore,
      "on-hand must be untouched",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reversing a receipt stays possible after the item is deactivated", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const movementId = await receiveWhileActive(org);
    await deactivateItem(org.orgId, org.items.fifo);
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const reversed = await reverseInventoryMovement(org.orgId, actorId, {
      movementId,
      reversalDate: org.date,
      reason: "supplier recalled the shipment after discontinuation",
    });
    assert.equal(reversed.alreadyReversed, false);
    assert.equal(reversed.movementIds.length, 1);
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.fifo, org.stockLocationId),
      { quantity: "0.0000", value: "0.0000", unitCost: "0" },
      "the reversal must restore the exact prior state",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a deactivation racing a receipt serializes to one refusal with no partial post", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  await editor.connect();
  let editorCommitted = false;
  let pendingReceipt: ReturnType<typeof receiveInventory> | undefined;
  try {
    const before = await postedCounts(org.orgId);

    // Hold the deactivation's FOR UPDATE uncommitted — the same lock the
    // item PATCH takes — so the receipt must queue on the items row.
    await editor.query("begin");
    await editor.query("select set_config('app.bypass_rls', 'on', true)");
    await editor.query(`update items set is_active = false where id = '${org.items.fifo}'`);

    pendingReceipt = receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "4",
      unitCost: "1",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });

    // Row-level waits never appear as ungranted relation locks in pg_locks
    // (they queue on the holder's transaction id), so watch the blocked
    // backend itself: the receipt's items read waiting on a Lock event.
    let queuedOnItems = false;
    for (let waited = 0; waited < 10_000 && !queuedOnItems; waited += 25) {
      const waiting = (await db.execute<{ waiting: boolean }>(sql`
        select exists(
          select 1 from pg_stat_activity
           where wait_event_type = 'Lock'
             and query ilike '%from items%'
        ) as waiting
      `)).rows[0]?.waiting;
      queuedOnItems = waiting === true;
      if (!queuedOnItems) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(queuedOnItems, true, "the receipt must wait for the concurrent deactivation");

    await editor.query("commit");
    editorCommitted = true;
    await assert.rejects(pendingReceipt, expectInactiveRefusal("FIFO Widget"));
    assert.deepEqual(await postedCounts(org.orgId), before, "the raced receipt must leave no partial post");
  } finally {
    if (!editorCommitted) await editor.query("rollback").catch(() => undefined);
    await editor.end().catch(() => undefined);
    await pendingReceipt?.catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
