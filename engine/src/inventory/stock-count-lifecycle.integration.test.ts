import assert from "node:assert/strict";
import test from "node:test";
import { createStockCount } from "./stock-counts.ts";
import { receiveInventory } from "./movements.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Stock-count lifecycle regressions (D1-lite, D2, D3). Integration partition
 * only (filename), against a scratch org.
 */

async function receiveTen(org: ScratchOrg, itemId: string): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "4",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

test("creating a count binds its multi-id lookups as one pg array", async () => {
  // Raw JS arrays interpolate as parenthesized lists under the pinned
  // drizzle, so `= any($1)` receives a bare scalar and every creation with
  // lines dies with 22P02. The house uuidArray helper binds one pg-array
  // param instead. Two different items force the multi-element shape.
  const org = await createScratchOrg();
  try {
    await receiveTen(org, org.items.fifo);
    await receiveTen(org, org.items.component);
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [
        { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
        { itemId: org.items.component, stockLocationId: org.stockLocationId },
      ],
    });
    assert.equal(count.status, "draft");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
