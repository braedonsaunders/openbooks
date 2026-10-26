import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createStockCount } from "./stock-counts.ts";
import { receiveTen } from "./integration-seeds.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A count observes each subject (item, stock location, lot and serial)
 * once. The engine refuses a duplicate at creation; storage refuses one
 * written past the engine, under the guard's own name, so no writer can
 * post two variances for one subject.
 */
test("storage refuses a duplicate count subject even past the engine", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveTen(org);
    const count = await createStockCount(org.orgId, null, {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      countedOn: org.date,
      lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
    });
    await assert.rejects(
      db.execute(sql`
        insert into stock_count_lines
          (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity)
        select ${randomUUID()}, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity
          from stock_count_lines
         where org_id = ${org.orgId} and stock_count_id = ${count.id}
         limit 1`),
      (error: unknown) => {
        let current: unknown = error;
        while (current instanceof Error) {
          if (/stock_count_lines_no_duplicate_subject/.test(current.message)) return true;
          current = (current as Error & { cause?: unknown }).cause;
        }
        assert.fail("the unique guard must refuse a direct duplicate subject by name");
      },
    );
    const [lines] = await db.execute<{ n: number }>(
      sql`
      select count(*)::int as n from stock_count_lines
       where org_id = ${org.orgId} and stock_count_id = ${count.id}`,
      "objects",
    );
    assert.equal(lines?.n, 1, "the count keeps its single line");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
