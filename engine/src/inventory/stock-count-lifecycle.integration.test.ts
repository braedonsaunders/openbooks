import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import {
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  startStockCount,
  submitStockCountForReview,
} from "./stock-counts.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Stock-count lifecycle regressions: duplicate subjects (D2), the posting
 * transaction contract (D1-lite), and the transactional feature fence (D3).
 * Runs in the integration partition only (filename), against a scratch org.
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

async function openCountedReview(org: ScratchOrg, counted: string): Promise<{ countId: string; lineId: string }> {
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

async function countStatus(orgId: string, countId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from stock_counts where org_id = ${orgId} and id = ${countId}`)).rows[0]!.status;
}

async function setInventoryFeature(orgId: string, enabled: boolean): Promise<void> {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${`{"inventory":${enabled}}`}::jsonb) where id=${orgId}`);
}

test("duplicate count lines are refused at creation, naming the subject", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const before = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from stock_counts where org_id = ${org.orgId}`)).rows[0]!.n;
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
        ],
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "a duplicate subject must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /duplicate count line/i);
        assert.match((e as Error).message, /count each item, stock location and lot once/i);
        return true;
      },
    );
    const after = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from stock_counts where org_id = ${org.orgId}`)).rows[0]!.n;
    assert.equal(after, before, "a refused creation must leave no count row behind");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the same item at two warehouses is two subjects, not a duplicate", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    // A second stock location under the SAME business location: one count
    // may cover both warehouses, and the same item in each is two subjects.
    const secondBin = randomUUID();
    await db.execute(sql`
      insert into stock_locations (id, org_id, location_id, code, kind, is_active)
      values (${secondBin}, ${org.orgId}, ${org.locationId}, 'STAGE2', 'warehouse', true)`);
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [
        { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
        { itemId: org.items.fifo, stockLocationId: secondBin },
      ],
    });
    assert.equal(count.status, "draft");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("distinct lots are distinct subjects: the refusal names duplicates, not lot validation", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const lotA = randomUUID();
    const lotB = randomUUID();
    // Two different lots pass the duplicate screen and reach lot validation —
    // the refusal must be the lot remedy, never the duplicate remedy.
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId, lotId: lotA },
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId, lotId: lotB },
        ],
      }),
      /lot does not belong/i,
    );
    // The same lot twice is a duplicate even before lot validation runs.
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId, lotId: lotA },
          { itemId: org.items.fifo, stockLocationId: org.stockLocationId, lotId: lotA },
        ],
      }),
      /duplicate count line/i,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("storage refuses a duplicate subject, including the NULL-lot case (0293)", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
    });
    // The untracked line carries NULL lot_id: without NULLS NOT DISTINCT this
    // insert would escape the guard and double-apply the variance at posting.
    // The constraint name lives on the driver's cause, not the drizzle
    // wrapper message, so the validator reads the cause chain.
    await assert.rejects(
      db.execute(sql`insert into stock_count_lines
        (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity)
        values (${randomUUID()}, ${org.orgId}, ${count.id}, ${org.items.fifo}, ${org.stockLocationId}, null, '10')`),
      (e: unknown) => {
        const cause = (e as { cause?: unknown }).cause as Error | undefined;
        assert.match(
          String(cause?.message ?? e),
          /stock_count_lines_no_duplicate_subject/i,
        );
        return true;
      },
      "a second NULL-lot line for the same subject must violate the 0293 constraint",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("creating a count binds its multi-id lookups as one pg array", async () => {
  // Raw JS arrays interpolate as parenthesized lists under the pinned
  // drizzle, so `= any($1)` receives a bare scalar and every creation with
  // lines dies with 22P02. The house uuidArray helper binds one pg-array
  // param instead. Two different items force the multi-element shape.
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    await receiveInventory(org.orgId, null, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "4",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
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

test("disabled Inventory refuses every count mutation inside its own transaction", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    await setInventoryFeature(org.orgId, false);
    const input = {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
    };
    await assert.rejects(createStockCount(org.orgId, null, input), /inventory feature is disabled/i);
    await setInventoryFeature(org.orgId, true);
    const count = await createStockCount(org.orgId, null, input);
    await startStockCount(org.orgId, null, count.id);
    const lineId = (await db.execute<{ id: string }>(sql`
      select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
    await setInventoryFeature(org.orgId, false);
    try {
      await assert.rejects(
        recordCountedQuantity(org.orgId, null, { countId: count.id, lineId, countedQuantity: "9" }),
        /inventory feature is disabled/i,
      );
      await assert.rejects(submitStockCountForReview(org.orgId, null, count.id), /inventory feature is disabled/i);
    } finally {
      await setInventoryFeature(org.orgId, true);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a zero-variance post with Inventory disabled refuses instead of marking posted", async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    // Counted == expected: no line ever reaches adjustInventory's own gate,
    // so only the post-level fence can refuse this.
    const { countId } = await openCountedReview(org, "10");
    await setInventoryFeature(org.orgId, false);
    try {
      await assert.rejects(
        withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, countId)),
        /inventory feature is disabled/i,
      );
    } finally {
      await setInventoryFeature(org.orgId, true);
    }
    assert.equal(await countStatus(org.orgId, countId), "review");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
