import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, env, withOrgTransaction } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { getOnHandWith } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { ensureLot } from "./tracking.ts";
import {
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  startStockCount,
  submitStockCountForReview,
} from "./stock-counts.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN4: the posting drift check raced concurrent movements. postStockCount
 * re-read on-hand holding only the stock_counts row lock, so a movement
 * committing between the re-read and the variance adjustments posted a
 * stale variance with no refusal. The post now takes every line position
 * lock BEFORE the re-read and holds them to the outer commit.
 */

async function receiveTen(org: ScratchOrg): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "4",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

async function openReviewedCount(org: ScratchOrg, counted: string): Promise<{ countId: string; lineId: string }> {
  const count = await createStockCount(org.orgId, null, {
    locationId: org.locationId,
    subsidiaryId: org.subsidiaryId,
    countedOn: org.date,
    lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  });
  await startStockCount(org.orgId, null, count.id);
  const lineId = (await db.execute<{ id: string }>(sql`
    select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
  await recordCountedQuantity(org.orgId, null, { countId: count.id, lineId, countedQuantity: counted });
  await submitStockCountForReview(org.orgId, null, count.id);
  return { countId: count.id, lineId };
}

async function lockWaiters(): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`)).rows[0]!.n;
}

test("two counts racing one position serialize: exactly one posts, the other refuses drift with nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  await editor.connect();
  let released = false;
  try {
    await receiveTen(org);
    const first = await openReviewedCount(org, "9");
    const second = await openReviewedCount(org, "9");

    // Barrier: hold the position lock at session level so both posts queue
    // before either can check or adjust. Releasing it lets them race; the
    // locks the post itself takes then decide the order deterministically.
    const positionKey = `inventory:${org.items.fifo}:${org.stockLocationId}`;
    await editor.query("begin");
    await editor.query(`select pg_advisory_lock(hashtextextended('${positionKey}', 0))`);

    const postA = withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, first.countId));
    const postB = withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, second.countId));
    // Silence unhandled rejections; the settlements below await both.
    postA.catch(() => undefined);
    postB.catch(() => undefined);

    let queued = 0;
    for (let waited = 0; waited < 10_000 && queued < 2; waited += 25) {
      queued = await lockWaiters();
      if (queued < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(queued >= 2, "both posts must queue on the position lock before either proceeds");

    await editor.query("select pg_advisory_unlock(hashtextextended($1, 0))", [positionKey]);
    await editor.query("rollback");
    released = true;

    const [a, b] = await Promise.allSettled([postA, postB]);
    const posted = [a, b].filter((r) => r.status === "fulfilled");
    const refused = [b, a].filter((r) => r.status === "rejected");
    assert.equal(posted.length, 1, "exactly one of the racing posts may commit");
    assert.equal(refused.length, 1, "the loser must refuse, not post");
    assert.match(
      String((refused[0] as PromiseRejectedResult).reason),
      /drifted/,
      "the loser must refuse on drift with the recount remedy",
    );

    const winner = (posted[0] as PromiseFulfilledResult<{ id: string }>).value;
    const loserId = winner.id === first.countId ? second.countId : first.countId;
    assert.equal(
      (await db.execute<{ status: string }>(sql`
        select status from stock_counts where org_id = ${org.orgId} and id = ${loserId}`)).rows[0]!.status,
      "review",
      "the refused count stays in review",
    );
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from stock_count_lines
         where org_id = ${org.orgId} and stock_count_id = ${loserId} and adjustment_movement_id is not null`)).rows[0]!.n,
      "0",
      "the refused count posts no adjustment",
    );
    assert.equal(
      (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
      "9.0000",
      "live stock reflects exactly one -1 variance on the 10 snapshot",
    );
    // Variance adjustments delegate to the receipt/issue path, so they
    // carry the count memo rather than an 'adjustment' kind.
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from inventory_movements
         where org_id = ${org.orgId} and memo like 'Stock count %'`)).rows[0]!.n,
      "1",
      "exactly one variance adjustment exists across both counts",
    );
  } finally {
    if (!released) {
      await editor.query("rollback").catch(() => undefined);
    }
    await editor.end().catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});

test("a lot-tracked line posts under the position locks; serial-tracked items still refuse at creation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update item_inventory_profiles set tracking = 'lot'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
    // moving_average costing is incompatible with tracked layers, so the
    // serial probe uses the (fifo) component item.
    await db.execute(sql`
      update item_inventory_profiles set tracking = 'serial'
       where org_id = ${org.orgId} and item_id = ${org.items.component}`);
    const lot = await ensureLot(org.orgId, org.items.fifo, "LOT-1", null, null);
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "1",
      lotId: lot,
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId, lotId: lot }],
    });
    await startStockCount(org.orgId, null, count.id);
    const lineId = (await db.execute<{ id: string }>(sql`
      select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
    await recordCountedQuantity(org.orgId, null, { countId: count.id, lineId, countedQuantity: "9" });
    await submitStockCountForReview(org.orgId, null, count.id);
    const posted = await withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, count.id));
    assert.equal(posted.status, "posted");
    assert.equal(
      (await getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId, { lotId: lot })).quantity,
      "9.0000",
      "the lot variance posts exactly",
    );

    const before = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from stock_counts where org_id = ${org.orgId}`)).rows[0]!.n;
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [{ itemId: org.items.component, stockLocationId: org.stockLocationId }],
      }),
      /serial-tracked items cannot be cycle-counted/,
    );
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from stock_counts where org_id = ${org.orgId}`)).rows[0]!.n,
      before,
      "a refused serial creation stores no draft",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
