import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import {
  createStockCount,
  recordCountedQuantity,
  startStockCount,
} from "./stock-counts.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN6: a negative counted quantity must refuse before any line, audit, or
 * stock write — at the engine boundary (recordCountedQuantity and
 * countVariance) and at storage (0299 CHECK). -1 and the sub-precision
 * -0.0001 both refuse; zero stays legal.
 */

async function openCountingLine(org: ScratchOrg): Promise<{ countId: string; lineId: string }> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
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
    lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  });
  await startStockCount(org.orgId, null, count.id);
  const lineId = (await db.execute<{ id: string }>(sql`
    select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
  return { countId: count.id, lineId };
}

for (const counted of ["-1", "-0.0001"]) {
  test(`recording ${counted} refuses before any line, audit, or stock write`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const { countId, lineId } = await openCountingLine(org);
      const movementsBefore = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n;
      const auditsBefore = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from audit_log where org_id = ${org.orgId}`)).rows[0]!.n;
      await assert.rejects(
        recordCountedQuantity(org.orgId, null, { countId, lineId, countedQuantity: counted }),
        (e: unknown) => {
          assert.ok(e instanceof InventoryError, "a negative count must refuse as InventoryError (HTTP 422)");
          assert.match((e as Error).message, /counted quantity cannot be negative/i);
          assert.match((e as Error).message, /zero or more/i);
          return true;
        },
      );
      assert.equal(
        (await db.execute<{ q: string | null }>(sql`
          select counted_quantity::text as q from stock_count_lines
           where org_id = ${org.orgId} and id = ${lineId}`)).rows[0]!.q,
        null,
        "the line keeps no observation",
      );
      assert.equal(
        (await db.execute<{ n: string }>(sql`
          select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n,
        movementsBefore,
        "no stock movement may be written",
      );
      assert.equal(
        (await db.execute<{ n: string }>(sql`
          select count(*)::text as n from audit_log where org_id = ${org.orgId}`)).rows[0]!.n,
        auditsBefore,
        "no audit row may be written",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("storage refuses a negative counted_quantity even past the engine (0299)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { lineId } = await openCountingLine(org);
    // The constraint name surfaces on the driver's cause, not on the
    // Drizzle wrapper message, so walk the chain like the BOM tests do.
    await assert.rejects(
      db.execute(sql`
        update stock_count_lines set counted_quantity = '-1'
         where org_id = ${org.orgId} and id = ${lineId}`),
      (e: unknown) => {
        let current: unknown = e;
        while (current instanceof Error) {
          if (/stock_count_lines_counted_nonnegative/.test(current.message)) return true;
          current = (current as Error & { cause?: unknown }).cause;
        }
        assert.fail("the CHECK must refuse a direct negative write by constraint name");
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
