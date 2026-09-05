import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, seedFlowActors, dropScratchOrg } from "./test-fixtures.ts";
import { receiveInventory, issueInventory, transferInventory, buildAssembly, postLandedCostVoucher, reverseInventoryMovement, reverseAssemblyBuild, reverseLandedCostVoucher, InventoryError } from "./inventory.ts";

for (const operation of ["receipt", "issue", "transfer", "assembly", "landed cost"] as const) {
  for (const timing of ["before source", "same day", "later day", "invalid calendar"] as const) {
    test(`inventory reversal chronology: ${operation}, ${timing}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = (await seedFlowActors(org.orgId)).adminId;
        const itemId = operation === "assembly" ? org.items.component : org.items.fifo;
        const receipt = await receiveInventory(org.orgId, actor, {
          itemId, stockLocationId: org.stockLocationId, quantity: "6", unitCost: "10",
          subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing,
          date: operation === "receipt" ? "2026-07-16" : "2026-07-15",
        });
        let movementId = receipt.movementId;
        let voucherId = "";
        if (operation === "issue") movementId = (await issueInventory(org.orgId, actor, {
          itemId, stockLocationId: org.stockLocationId, quantity: "2",
          subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.cogs, date: "2026-07-16",
        })).movementId;
        if (operation === "transfer") movementId = (await transferInventory(org.orgId, actor, {
          itemId, fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
          quantity: "2", subsidiaryId: org.subsidiaryId, date: "2026-07-16",
        })).fromMovementId;
        if (operation === "assembly") movementId = (await buildAssembly(org.orgId, actor, {
          assemblyItemId: org.items.assembly, stockLocationId: org.stockLocationId,
          quantity: "1", subsidiaryId: org.subsidiaryId, date: "2026-07-16",
        })).movementId;
        if (operation === "landed cost") voucherId = (await postLandedCostVoucher(org.orgId, actor, {
          amount: "6", basis: "quantity", freightAccountId: org.accounts.freight,
          subsidiaryId: org.subsidiaryId, voucherDate: "2026-07-16",
          targets: [{ itemId, stockLocationId: org.stockLocationId }],
        })).id;
        const reversalDate = timing === "before source" ? "2026-07-15" : timing === "same day" ? "2026-07-16" : timing === "later day" ? "2026-07-17" : "2026-02-30";
        const input = { movementId, voucherId, reversalDate, reason: "Chronology control review" };
        const reverse = () => operation === "landed cost"
          ? reverseLandedCostVoucher(org.orgId, actor, input)
          : operation === "assembly" ? reverseAssemblyBuild(org.orgId, actor, input)
          : reverseInventoryMovement(org.orgId, actor, input);
        const snapshot = async () => (await db.execute(sql`
          select (select jsonb_agg(to_jsonb(m) order by id) from inventory_movements m where org_id=${org.orgId}) as movements,
                 (select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${org.orgId}) as layers,
                 (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries,
                 (select jsonb_agg(to_jsonb(a) order by id) from landed_cost_allocations a where org_id=${org.orgId}) as allocations
        `)).rows;
        if (timing === "before source" || timing === "invalid calendar") {
          const before = await snapshot();
          await assert.rejects(reverse, InventoryError);
          assert.deepEqual(await snapshot(), before, "refused reversal preserves stock, journals and allocation evidence");
        } else {
          const result = await reverse();
          assert.equal(result.alreadyReversed, false);
          assert.ok(result.entryId || operation === "transfer");
          assert.equal((await reverse()).alreadyReversed, true);
        }
        const totals = (await db.execute<{ gl: string; layers: string }>(sql`
          select (select coalesce(sum(amount),0)::text from journal_lines where org_id=${org.orgId} and account_id=${org.accounts.invAsset}) as gl,
                 (select coalesce(sum(round(remaining_quantity * unit_cost,4)),0)::text from cost_layers where org_id=${org.orgId}) as layers
        `)).rows[0]!;
        assert.equal(totals.gl, totals.layers, "inventory GL reconciles to remaining layers");
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
