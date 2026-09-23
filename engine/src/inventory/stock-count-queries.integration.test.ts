import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { listStockCounts } from "./stock-count-queries.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Stock-count list regressions: cursor pagination past 500 rows (D6).
 * Subsidiary scoping (D4) and discrepant-line variance (D5) follow.
 * Integration partition only (filename), against scratch orgs.
 */

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
    for (;;) {
      const page = await listStockCounts(org.orgId, { limit: 200, cursor });
      pages += 1;
      assert.ok(page.totalCount === 505, `total must evidence all 505 counts (page ${pages})`);
      for (const row of page.counts) {
        assert.ok(!seen.has(row.id), `count ${row.id} repeated across pages`);
        seen.add(row.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      assert.ok(pages < 10, "paging must terminate");
    }
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
