import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import {
  getOnHand,
  receiveInventory,
  reverseInventoryMovement,
  transferInventory,
} from "./inventory.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Count backends parked inside an inventory position lock, other than this
 * test's own backend. A parked backend stays parked for seconds here (it is
 * held by the test's brake lock), while incidental parks elsewhere last
 * microseconds — requiring the count twice in a row filters those out.
 */
async function parkedPositionLocks(expected: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  let steady = 0;
  for (;;) {
    const parked = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query like '%pg_advisory_xact_lock%'
    `)).rows[0]!.n;
    steady = parked >= expected ? steady + 1 : 0;
    if (steady >= 2) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${expected} parked position locks`);
    await sleep(250);
  }
}

test("a transfer reversal racing an opposite-direction transfer converges without deadlock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const brake = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const item = org.items.component;
    // The reversal locks the transfer-out leg first; the transfer locks the
    // lower location first. Staging out = HI inverts the two orders.
    const LO = org.stockLocationId < org.stockLocationId2 ? org.stockLocationId : org.stockLocationId2;
    const HI = org.stockLocationId < org.stockLocationId2 ? org.stockLocationId2 : org.stockLocationId;
    const positionKey = (locationId: string) => `inventory:${item}:${locationId}`;
    for (const locationId of [HI, LO]) {
      await receiveInventory(org.orgId, actor, {
        itemId: item,
        stockLocationId: locationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
    }
    const baseline = await transferInventory(org.orgId, actor, {
      itemId: item,
      fromStockLocationId: HI,
      toStockLocationId: LO,
      quantity: "3",
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });

    // Parking brake: a session-level lock on the HI position key. The
    // reversal parks holding nothing-or-HI while the transfer parks holding
    // LO; releasing the brake then forces the exact opposite-order
    // acquisition that deadlocks when the two sides disagree on lock order.
    await brake.connect();
    await brake.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [positionKey(HI)]);
    const reversal = reverseInventoryMovement(org.orgId, actor, {
      movementId: baseline.fromMovementId,
      reversalDate: org.date,
      reason: "Cancel a warehouse transfer entered in error",
    });
    await parkedPositionLocks(1);
    const transfer = transferInventory(org.orgId, actor, {
      itemId: item,
      fromStockLocationId: LO,
      toStockLocationId: HI,
      quantity: "2",
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    await parkedPositionLocks(2);
    await brake.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [positionKey(HI)]);

    // A 40P01 deadlock_detected rejection here is the defect: one warehouse
    // user's reversal dies with a raw driver error (HTTP 500).
    const [reversed, moved] = await Promise.all([reversal, transfer]);
    assert.equal(reversed.alreadyReversed, false);
    assert.equal(reversed.movementIds.length, 2);
    assert.ok(moved.fromMovementId);

    // Exactly-once convergence, independent of commit order:
    // HI = 10 - 3 + 3 + 2, LO = 10 + 3 - 3 - 2.
    assert.equal(toUnits((await getOnHand(org.orgId, item, HI)).quantity), toUnits("12"));
    assert.equal(toUnits((await getOnHand(org.orgId, item, LO)).quantity), toUnits("8"));
    const unbalanced = (await db.execute<{ entry_id: string }>(sql`
      select entry_id from journal_lines
       where org_id = ${org.orgId}
       group by entry_id having sum(amount) <> 0`));
    assert.equal(unbalanced.rows.length, 0);
  } finally {
    await brake.end().catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
