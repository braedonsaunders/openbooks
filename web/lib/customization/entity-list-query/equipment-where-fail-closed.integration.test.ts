import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The equipment list interpolates the charge_item_id / fixed_asset_id
// structured filters into uuid columns uncast: a crafted value (or a saved
// view holding one) dies as a raw throw and the whole page 500s. The builder
// must fail such filters closed to an empty row set. SQL builders and
// storage are real; only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { equipmentWhere } = await import("./equipment.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function equipmentCount(orgId: string, viewFilters: Filter[] = []): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from equipment_units eu
      where ${equipmentWhere({ ...defaultListView("equipment_unit"), filters: viewFilters as never }, {}, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed equipment filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await equipmentCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await equipmentCount(org.orgId, [{ key: "charge_item_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed charge-item filter matches nothing",
    );
    assert.equal(
      await equipmentCount(org.orgId, [{ key: "fixed_asset_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed fixed-asset filter matches nothing",
    );
    assert.equal(
      await equipmentCount(org.orgId, [
        { key: "charge_item_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown charge item stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
