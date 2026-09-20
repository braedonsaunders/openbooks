import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import {
  adjustInventory,
  receiveInventory,
  reverseInventoryMovement,
} from "./inventory.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Fraud probe: inventory movements post their GL legs through
 * postInventoryEntry / reverseInventoryJournal — raw inserts that never call
 * the posting kernel — so they must still honor a GL-closed period. A
 * backdated write-up or write-down into a closed period would restate closed
 * financials with no approval and no reopen.
 */

async function inventoryEntryCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries
     where org_id = ${orgId} and origin = 'inventory'`));
  return r.rows[0]!.n;
}

async function closeGlForPeriod(
  orgId: string,
  periodId: string,
  bookId: string,
  actorId: string,
): Promise<void> {
  await setPeriodLockState({
    orgId,
    periodId,
    bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fraud probe: GL closed for the period",
  });
}

test("a GL-closed period refuses inventory write-ups dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Counter", "inventory_clerk");
    await closeGlForPeriod(org.orgId, org.periodId, org.bookId, actor);
    const before = await inventoryEntryCount(org.orgId);
    await assert.rejects(
      adjustInventory(org.orgId, actor, {
        itemId: org.items.movingAvg,
        stockLocationId: org.stockLocationId,
        quantityDelta: "5",
        unitCost: "10.00",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        memo: "fraud probe: backdated write-up",
      }),
      /closed/i,
      "a write-up into a GL-closed period must be refused",
    );
    assert.equal(await inventoryEntryCount(org.orgId), before, "refused adjustment left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a GL-closed period refuses inventory write-downs dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Counter", "inventory_clerk");
    // Seed on-hand while the period is still open.
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "10.00",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await closeGlForPeriod(org.orgId, org.periodId, org.bookId, actor);
    const before = await inventoryEntryCount(org.orgId);
    await assert.rejects(
      adjustInventory(org.orgId, actor, {
        itemId: org.items.movingAvg,
        stockLocationId: org.stockLocationId,
        quantityDelta: "-4",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        memo: "fraud probe: backdated write-down",
      }),
      /closed/i,
      "a write-down into a GL-closed period must be refused",
    );
    assert.equal(await inventoryEntryCount(org.orgId), before, "refused adjustment left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a GL-closed period refuses inventory reversals dated inside it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Counter", "inventory_clerk");
    const receipt = await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "10.00",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await closeGlForPeriod(org.orgId, org.periodId, org.bookId, actor);
    const before = await inventoryEntryCount(org.orgId);
    await assert.rejects(
      reverseInventoryMovement(org.orgId, actor, {
        movementId: receipt.movementId,
        reversalDate: org.date,
        reason: "fraud probe: backdated reversal",
      }),
      /closed/i,
      "a reversal into a GL-closed period must be refused",
    );
    assert.equal(await inventoryEntryCount(org.orgId), before, "refused reversal left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
