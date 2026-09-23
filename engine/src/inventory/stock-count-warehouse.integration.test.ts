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

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN5: counts against an inactive or foreign-entity warehouse must refuse at
 * creation — before any draft is stored — and re-validate before review and
 * post, so a later restriction edit refuses with a named remedy instead of
 * stranding the count (or dying inside adjustInventory mid-post).
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

async function countRows(orgId: string): Promise<string> {
  return (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from stock_counts where org_id = ${orgId}`)).rows[0]!.n;
}

async function openCounted(org: ScratchOrg, counted: string): Promise<{ countId: string; lineId: string }> {
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
  return { countId: count.id, lineId };
}

/** A second legal entity the warehouse can be restricted to (a child: one root per org). */
async function seedOtherSubsidiary(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Foreign Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

test("creating a count on an inactive warehouse refuses by name before any draft", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    await db.execute(sql`
      update stock_locations set is_active = false where org_id = ${org.orgId} and id = ${org.stockLocationId}`);
    const before = await countRows(org.orgId);
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /MAIN/, "the refusal must name the warehouse");
        assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
        assert.match((e as Error).message, /reactivate/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.equal(await countRows(org.orgId), before, "no draft may be stored");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("creating a count on a warehouse restricted to another entity refuses", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const foreign = await seedOtherSubsidiary(org);
    await db.execute(sql`
      update locations set subsidiary_id = ${foreign}, subsidiary_include_children = false
       where org_id = ${org.orgId} and id = ${org.locationId}`);
    const before = await countRows(org.orgId);
    await assert.rejects(
      createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId: org.subsidiaryId,
        countedOn: org.date,
        lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /another legal entity/, "the refusal must name the entity boundary");
        assert.match((e as Error).message, /admitted subsidiary/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.equal(await countRows(org.orgId), before, "no draft may be stored");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a restriction edited after creation refuses at submit with the count still open", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const { countId } = await openCounted(org, "9");
    const foreign = await seedOtherSubsidiary(org);
    await db.execute(sql`
      update locations set subsidiary_id = ${foreign}, subsidiary_include_children = false
       where org_id = ${org.orgId} and id = ${org.locationId}`);
    await assert.rejects(
      submitStockCountForReview(org.orgId, null, countId),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /another legal entity/, "the refusal must name the entity boundary");
        return true;
      },
    );
    assert.equal(
      (await db.execute<{ status: string }>(sql`
        select status from stock_counts where org_id = ${org.orgId} and id = ${countId}`)).rows[0]!.status,
      "counting",
      "the count stays open for counting instead of stranding in review",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a warehouse deactivated after review refuses at post with no adjustment", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const { countId } = await openCounted(org, "10");
    await submitStockCountForReview(org.orgId, null, countId);
    await db.execute(sql`
      update stock_locations set is_active = false where org_id = ${org.orgId} and id = ${org.stockLocationId}`);
    const movementsBefore = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n;
    await assert.rejects(
      withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, countId)),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /MAIN/, "the refusal must name the warehouse");
        assert.match((e as Error).message, /inactive/, "the refusal must say inactive");
        assert.match((e as Error).message, /reactivate/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n,
      movementsBefore,
      "no adjustment may post — not even a zero-variance one",
    );
    assert.equal(
      (await db.execute<{ status: string }>(sql`
        select status from stock_counts where org_id = ${org.orgId} and id = ${countId}`)).rows[0]!.status,
      "review",
      "the count stays in review",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
