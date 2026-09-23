import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, env } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { buildAssembly } from "./assembly.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN1: deactivated items must not be built. A build mints NEW stock, so an
 * inactive finished good or component refuses by name inside the build
 * transaction — before any consumption, movement, or journal line — and a
 * deactivation racing a build serializes to exactly one outcome.
 */

async function receiveComponents(org: ScratchOrg): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.component,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "1",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

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

test("building an inactive finished item is refused by name with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveComponents(org);
    await deactivateItem(org.orgId, org.items.assembly);
    const before = await postedCounts(org.orgId);
    const componentBefore = await getOnHand(org.orgId, org.items.component, org.stockLocationId);
    await assert.rejects(
      buildAssembly(org.orgId, null, {
        assemblyItemId: org.items.assembly,
        quantity: "2",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "inactive build must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /Assembly/, "the refusal must name the finished item");
        assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
        assert.match((e as Error).message, /reactivate/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "components must not be consumed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("building with an inactive component is refused by name with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveComponents(org);
    await deactivateItem(org.orgId, org.items.component);
    const before = await postedCounts(org.orgId);
    await assert.rejects(
      buildAssembly(org.orgId, null, {
        assemblyItemId: org.items.assembly,
        quantity: "2",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "inactive component must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /Component/, "the refusal must name the component item");
        assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
        return true;
      },
    );
    assert.deepEqual(await postedCounts(org.orgId), before, "no movement, journal, or layer may be written");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a deactivation racing a build serializes to one refusal with no partial post", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  await editor.connect();
  let editorCommitted = false;
  let pendingBuild: ReturnType<typeof buildAssembly> | undefined;
  try {
    await receiveComponents(org);
    const before = await postedCounts(org.orgId);
    const componentBefore = await getOnHand(org.orgId, org.items.component, org.stockLocationId);

    // Hold the deactivation's FOR UPDATE uncommitted — the same lock the
    // item PATCH takes — so the build must queue on the items row.
    await editor.query("begin");
    await editor.query("select set_config('app.bypass_rls', 'on', true)");
    await editor.query(`update items set is_active = false where id = '${org.items.assembly}'`);

    pendingBuild = buildAssembly(org.orgId, null, {
      assemblyItemId: org.items.assembly,
      quantity: "2",
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });

    // Row-level waits never appear as ungranted relation locks in pg_locks
    // (they queue on the holder's transaction id), so watch the blocked
    // backend itself: the build's items read waiting on a Lock event.
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
    assert.equal(queuedOnItems, true, "the build must wait for the concurrent deactivation");

    await editor.query("commit");
    editorCommitted = true;
    await assert.rejects(pendingBuild, (e: unknown) => {
      assert.ok(e instanceof InventoryError, "the loser must refuse as InventoryError (HTTP 422)");
      assert.match((e as Error).message, /Assembly/, "the refusal must name the finished item");
      assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
      return true;
    });
    assert.deepEqual(await postedCounts(org.orgId), before, "the raced build must leave no partial post");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "components must not be consumed",
    );
  } finally {
    if (!editorCommitted) await editor.query("rollback").catch(() => undefined);
    await editor.end().catch(() => undefined);
    await pendingBuild?.catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
