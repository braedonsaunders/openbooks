import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { adjustInventory, buildAssembly, issueInventory, postLandedCostVoucher, receiveInventory } from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

async function evidence(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'layers',(select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${orgId}),
    'movements',(select jsonb_agg(to_jsonb(m) order by id) from inventory_movements m where org_id=${orgId}),
    'journals',(select jsonb_agg(to_jsonb(j) order by id) from journal_entries j where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from journal_lines l where org_id=${orgId}),
    'vouchers',(select jsonb_agg(to_jsonb(v) order by id) from landed_cost_vouchers v where org_id=${orgId}),
    'writedowns',(select jsonb_agg(to_jsonb(w) order by id) from inventory_writedowns w where org_id=${orgId})
  ) as state`)).rows[0]!.state;
}

for (const operation of ["receipt variance", "build variance", "landed variance", "NRV", "NRV recovery",
  "receipt offset", "uppercase receipt offset", "issue offset", "adjustment", "landed offset"] as const) {
  test(`inventory separates valuation accounts: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const isVariance = operation.endsWith("variance");
      const isNrv = operation.startsWith("NRV");
      const itemId = operation === "build variance" ? org.items.assembly : isVariance ? org.items.standard : org.items.fifo;
      const input = { itemId, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId,
        quantity: "10", unitCost: "5", date: org.date, offsetAccountId: org.accounts.clearing };
      if (operation === "build variance") await receiveInventory(org.orgId, actorId, { ...input, itemId: org.items.component });
      else if (!operation.includes("receipt")) await receiveInventory(org.orgId, actorId, { ...input,
        unitCost: operation === "landed variance" ? "3" : "5" });
      if (isNrv) {
        await db.execute(sql`update orgs set settings=settings||'{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
        if (operation === "NRV recovery") await writeDownInventoryToNrv(org.orgId, actorId, { ...input, nrvPerUnit: "4" });
      }
      if (isVariance) await db.execute(sql`update item_inventory_profiles set costing_method='standard',standard_cost='3',variance_account_id=asset_account_id
        where org_id=${org.orgId} and item_id=${itemId}`);
      if (isNrv || operation === "adjustment") await db.execute(sql`update item_inventory_profiles set adjustment_account_id=asset_account_id
        where org_id=${org.orgId} and item_id=${itemId}`);
      const before = await evidence(org.orgId);
      let invalid = true;
      const run = () => {
        const offsetAccountId = invalid && operation.includes("offset")
          ? operation.startsWith("uppercase") ? org.accounts.invAsset.toUpperCase() : org.accounts.invAsset
          : org.accounts.clearing;
        if (operation.includes("receipt")) return receiveInventory(org.orgId, actorId, { ...input, offsetAccountId });
        if (operation === "issue offset") return issueInventory(org.orgId, actorId, { ...input, quantity: "1", offsetAccountId });
        if (operation === "adjustment") return adjustInventory(org.orgId, actorId, { ...input, quantityDelta: "1" });
        if (operation === "build variance") return buildAssembly(org.orgId, actorId, { ...input, assemblyItemId: itemId, quantity: "1" });
        if (operation === "NRV") return writeDownInventoryToNrv(org.orgId, actorId, { ...input, nrvPerUnit: "4" });
        if (operation === "NRV recovery") return reverseInventoryWritedown(org.orgId, actorId, { ...input, nrvPerUnit: "5" });
        return postLandedCostVoucher(org.orgId, actorId, { amount: "5", basis: "quantity",
          freightAccountId: invalid && operation === "landed offset" ? org.accounts.invAsset : org.accounts.freight,
          subsidiaryId: org.subsidiaryId, voucherDate: org.date, targets: [{ itemId, stockLocationId: org.stockLocationId }] });
      };
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(run(), /account must be distinct/);
        assert.deepEqual(await evidence(org.orgId), before, "refusal must precede stock consumption and financial writes");
      });
      await db.execute(sql`update item_inventory_profiles set variance_account_id=${org.accounts.adjustment},adjustment_account_id=${org.accounts.adjustment}
        where org_id=${org.orgId} and item_id=${itemId}`);
      invalid = false;
      assert.ok(await run());
      assert.equal((await db.execute<{ balanced: boolean }>(sql`select
        (select sum(remaining_quantity*unit_cost) from cost_layers where org_id=${org.orgId}) =
        (select sum(amount) from journal_lines where org_id=${org.orgId} and account_id=${org.accounts.invAsset}) as balanced`)).rows[0]!.balanced, true);
    } finally { await dropScratchOrg(org.orgId); }
  });
}
