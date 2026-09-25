import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { createStockCount, startStockCount } from "./stock-counts.ts";

/**
 * The scratch-tenant fields these seeds read. Structural on purpose: the
 * helper stays inside the inventory module (no testing edge) while any
 * ScratchOrg satisfies it by construction.
 */
export type StockCountSeedOrg = {
  orgId: string;
  date: string;
  locationId: string;
  stockLocationId: string;
  subsidiaryId: string;
  items: { fifo: string };
  accounts: { clearing: string };
};

/**
 * Shared seed fixtures for the inventory stock-count integration suites
 * (DB-owned).
 *
 * `receiveTen` and `openCountingLine` were copy-pasted across the
 * stock-count suites byte-for-byte; they live here once. Pure seed calls —
 * no assertions, so no behavioural cover moves.
 */
export async function receiveTen(org: StockCountSeedOrg): Promise<void> {
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

export async function openCountingLine(org: StockCountSeedOrg): Promise<{ countId: string; lineId: string }> {
  await receiveTen(org);
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

export async function deactivateItem(orgId: string, itemId: string): Promise<void> {
  const r = await db.execute<{ id: string }>(sql`
    update items set is_active = false, updated_at = now()
     where org_id = ${orgId} and id = ${itemId}
    returning id`);
  assert.equal(r.rows.length, 1, "deactivation must match exactly one row");
}

export async function postedCounts(orgId: string): Promise<{ movements: number; entries: number; layers: number }> {
  return (await db.execute<{ movements: number; entries: number; layers: number }>(sql`
    select (select count(*)::int from inventory_movements where org_id = ${orgId}) as movements,
           (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
           (select count(*)::int from cost_layers where org_id = ${orgId}) as layers
  `)).rows[0]!;
}
