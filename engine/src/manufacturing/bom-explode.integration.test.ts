import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { explodeBom, whereUsed } from "./bom-explode.ts";
import { ManufacturingError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  const { assembly: a, component: b, fifo: c } = org.items;
  for (const [id, code] of [[a, "A-100"], [b, "B-200"], [c, "C-300"]])
    await db.execute(sql`update items set code = ${code} where org_id = ${org.orgId} and id = ${id}`);
  await db.execute(sql`delete from bom_components where org_id = ${org.orgId} and assembly_item_id in (${a}, ${b})`);
  return { a, b, c };
}
async function line(orgId: string, parent: string, item: string, qty: string, from: string | null = null, to: string | null = null, scrap: string | null = null, byproduct = false) {
  await db.execute(sql`insert into bom_components (org_id, assembly_item_id, component_item_id, quantity_per, sort_order, effective_from, effective_to, scrap_pct, is_byproduct)
    values (${orgId}, ${parent}, ${item}, ${qty}, 0, ${from}, ${to}, ${scrap}, ${byproduct})`);
}

const cases: { name: string; run: (org: Awaited<ReturnType<typeof createScratchOrg>>) => Promise<void> }[] = [
  { name: "effective multi-level explosion applies scrap and separates by-products", run: async (org) => {
    const { a, b, c } = await setup(org);
    await db.execute(sql`insert into mfg_item_policies (org_id, item_id, supply_method, safety_stock_qty, minimum_qty, order_multiple_qty, scrap_pct_planned) values (${org.orgId}, ${b}, 'make', 0, 0, 0, 0)`);
    await line(org.orgId, a, b, "2", "2026-01-01", "2026-07-01", "10");
    await line(org.orgId, a, b, "4", "2026-07-01");
    await line(org.orgId, a, c, "7", null, null, null, true);
    await line(org.orgId, b, c, "3");
    const before = await explodeBom(db, org.orgId, a, "5", "2026-06-30");
    const after = await explodeBom(db, org.orgId, a, "5", "2026-07-01");
    assert.deepEqual(before.components.map((x) => x.requiredQuantity), ["33.0000"]);
    assert.deepEqual(after.components.map((x) => x.requiredQuantity), ["60.0000"]);
    assert.equal(before.components[0]?.path.join(" → "), "A-100 → B-200 → C-300");
    assert.deepEqual(before.byproducts.map((x) => x.requiredQuantity), ["35.0000"]);
  } },
  { name: "a realistic two-item cycle names both item codes", run: async (org) => {
    const { a, b } = await setup(org);
    await db.execute(sql`insert into mfg_item_policies (org_id, item_id, supply_method, safety_stock_qty, minimum_qty, order_multiple_qty, scrap_pct_planned) values (${org.orgId}, ${b}, 'make', 0, 0, 0, 0)`);
    await line(org.orgId, a, b, "1"); await line(org.orgId, b, a, "1");
    await assert.rejects(explodeBom(db, org.orgId, a, "1", "2026-09-01"), (error: unknown) => error instanceof ManufacturingError && error.code === "bom_cycle" && /A-100 → B-200 → A-100/.test(error.message));
  } },
  { name: "where-used returns each active path to a shared component", run: async (org) => {
    const { a, b, c } = await setup(org);
    await line(org.orgId, a, b, "1"); await line(org.orgId, a, c, "1"); await line(org.orgId, b, c, "1");
    const paths = await whereUsed(db, org.orgId, c, "2026-09-01");
    assert.deepEqual(paths.map((x) => x.path.join(" → ")).sort(), ["A-100 → B-200 → C-300", "A-100 → C-300", "B-200 → C-300"]);
  } },
];

for (const scenario of cases) test(scenario.name, { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try { await scenario.run(org); } finally { await dropScratchOrg(org.orgId); }
});
