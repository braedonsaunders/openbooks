import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { receiveInventory } from "./movements.ts";
import {
  createStockCount,
  recordCountedQuantity,
  startStockCount,
} from "./stock-counts.ts";
import { listStockCounts } from "./stock-count-queries.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Stock-count list regressions: subsidiary scoping (D4), discrepant-line
 * variance (D5), and cursor pagination past 500 rows (D6). Integration
 * partition only (filename), against scratch orgs.
 */

async function secondSubsidiary(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  // One root per org: the scratch fixture already created it, so the second
  // legal entity hangs under the root.
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

test("the list scopes to the caller's subsidiary grant; an empty grant sees nothing", async () => {
  const org = await createScratchOrg();
  try {
    const subB = await secondSubsidiary(org);
    for (const subsidiaryId of [org.subsidiaryId, subB]) {
      await createStockCount(org.orgId, null, {
        locationId: org.locationId,
        subsidiaryId,
        countedOn: org.date,
        lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
      });
    }
    const onlyA = await listStockCounts(org.orgId, { subsidiaryIds: [org.subsidiaryId] });
    assert.equal(onlyA.totalCount, 1);
    assert.equal(onlyA.counts.length, 1);
    const both = await listStockCounts(org.orgId, { subsidiaryIds: [org.subsidiaryId, subB] });
    assert.equal(both.totalCount, 2);
    // An empty grant fails closed: no rows, no total, no cursor.
    assert.deepEqual(await listStockCounts(org.orgId, { subsidiaryIds: [] }), {
      counts: [],
      totalCount: 0,
      nextCursor: null,
    });
    // Full access still reads org-wide.
    assert.equal((await listStockCounts(org.orgId, {})).totalCount, 2);
    assert.equal((await listStockCounts(org.orgId)).totalCount, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("offsetting variances stay visibly discrepant; no cross-item sum is shown", async () => {
  const org = await createScratchOrg();
  try {
    for (const itemId of [org.items.fifo, org.items.component]) {
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
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [
        { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
        { itemId: org.items.component, stockLocationId: org.stockLocationId },
      ],
    });
    await startStockCount(org.orgId, null, count.id);
    const lines = (await db.execute<{ id: string; item_id: string }>(sql`
      select id, item_id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows;
    // −5 on one line, +5 on the other: a quantity sum would read 0.
    for (const line of lines) {
      await recordCountedQuantity(org.orgId, null, {
        countId: count.id,
        lineId: line.id,
        countedQuantity: line.item_id === org.items.fifo ? "5" : "15",
      });
    }
    const page = await listStockCounts(org.orgId, {});
    assert.equal(page.counts.length, 1);
    assert.equal(page.counts[0]!.discrepantLineCount, 2);
    assert.ok(!("variance" in page.counts[0]!), "the cross-item quantity sum must be gone");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("cursor pages reach past 500 rows with total and next-page evidence", async () => {
  const org = await createScratchOrg();
  try {
    // 505 posted counts with strictly staggered dates; the oldest must stay
    // reachable through the product list instead of vanishing past row 500.
    // Row n backdates n-1 days, so the last id is the oldest count.
    const ids = Array.from({ length: 505 }, () => randomUUID());
    const oldestId = ids[ids.length - 1]!;
    await db.execute(sql`
      insert into stock_counts (id, org_id, location_id, subsidiary_id, status, counted_on)
      select u.id, ${org.orgId}, ${org.locationId}, ${org.subsidiaryId}, 'posted',
             (${org.date}::date - ((u.n - 1) || ' days')::interval)::date
        from unnest(${uuidArray(ids)}::uuid[]) with ordinality as u(id, n)
    `);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    // Position in the seeded sequence: row n backdates n-1 days and the
    // list orders by counted_on desc, so page order must replay `ids` in
    // array order. Comparing every row pins the order, not just uniqueness.
    let position = 0;
    for (;;) {
      const page = await listStockCounts(org.orgId, { limit: 200, cursor });
      pages += 1;
      assert.ok(page.totalCount === 505, `total must evidence all 505 counts (page ${pages})`);
      assert.ok(
        page.counts.length >= 1 && page.counts.length <= 200,
        `page ${pages} must carry a bounded non-empty slice (saw ${page.counts.length})`,
      );
      for (const row of page.counts) {
        assert.ok(!seen.has(row.id), `count ${row.id} repeated across pages`);
        seen.add(row.id);
        assert.equal(row.id, ids[position]!, `page ${pages} row ${position} must replay the seeded order`);
        position += 1;
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      assert.ok(pages < 10, "paging must terminate");
    }
    assert.equal(position, 505, "every one of the 505 seeded counts anchored in order");
    assert.equal(seen.size, 505, "every count, including #501+, is reachable");
    assert.ok(seen.has(oldestId), "the oldest posted count is reachable through the list");
    assert.equal(pages, 3, "200 + 200 + 105 in three bounded pages");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an invalid page cursor refuses instead of silently restarting", async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(listStockCounts(org.orgId, { cursor: "not-a-cursor" }), /page cursor is invalid/i);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
