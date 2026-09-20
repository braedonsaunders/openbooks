import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The inventory lists interpolate item_id / stock_location_id / moved_at
// structured filters into uuid/date columns uncast: a crafted value (or a
// saved view holding one) dies as a raw throw and the whole page 500s. Both
// builders must fail such filters closed to an empty row set. SQL builders
// and storage are real; only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { inventoryOnhandWhere, inventoryMovementWhere } = await import("./inventory.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function onhandCount(orgId: string, viewFilters: Filter[] = []): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from cost_layers oh
      where ${inventoryOnhandWhere({ ...defaultListView("inventory_onhand"), filters: viewFilters as never }, {}, orgId)}`)
  ).rows;
  return rows[0]!.n;
}

async function movementCount(orgId: string, viewFilters: Filter[] = []): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements m
      where ${inventoryMovementWhere({ ...defaultListView("inventory_movement"), filters: viewFilters as never }, {}, orgId)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed inventory filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await onhandCount(org.orgId)) >= 0, "onhand baseline counts without throwing");
    assert.ok((await movementCount(org.orgId)) >= 0, "movement baseline counts without throwing");
    assert.equal(
      await onhandCount(org.orgId, [{ key: "item_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed onhand item filter matches nothing",
    );
    assert.equal(
      await onhandCount(org.orgId, [{ key: "stock_location_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed onhand location filter matches nothing",
    );
    assert.equal(
      await movementCount(org.orgId, [{ key: "item_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed movement item filter matches nothing",
    );
    assert.equal(
      await movementCount(org.orgId, [{ key: "moved_at", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed movement date filter matches nothing",
    );
    assert.equal(
      await movementCount(org.orgId, [
        { key: "item_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown item stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
