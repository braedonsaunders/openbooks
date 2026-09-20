import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The fixed-asset list interpolates the category_id and acquired_on
// structured filters into uuid/date columns uncast: a crafted value (or a
// saved view holding one) dies as a raw throw and the whole page 500s. The
// builder must fail such filters closed to an empty row set. SQL builders
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
const { fixedAssetWhere } = await import("./fixed-assets.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function assetCount(
  orgId: string,
  viewFilters: { key: string; operator: string; value?: string | null; to?: string | null }[] = [],
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from fixed_assets a
      where ${fixedAssetWhere({ ...defaultListView("fixed_asset"), filters: viewFilters as never }, {}, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed fixed-asset filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await assetCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await assetCount(org.orgId, [{ key: "category_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed category filter matches nothing",
    );
    assert.equal(
      await assetCount(org.orgId, [{ key: "acquired_on", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed acquired_on filter matches nothing",
    );
    assert.equal(
      await assetCount(org.orgId, [
        { key: "category_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown category stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
