import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, seedFlowActors, dropScratchOrg } from "./test-fixtures.ts";
import { receiveInventory, getOnHand } from "./inventory.ts";
import { writeDownInventoryToNrv, reverseInventoryWritedown, InventoryNrvError } from "./inventory-nrv.ts";

for (const timing of ["before source", "same day", "later day", "mixed future source", "invalid calendar"] as const) {
  test(`NRV reversal chronology: ${timing}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
      await receiveInventory(org.orgId, actor, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "10",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: "2026-07-15",
      });
      const common = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId };
      if (timing === "mixed future source") await writeDownInventoryToNrv(org.orgId, actor, { ...common, date: "2026-07-15", nrvPerUnit: "8" });
      await writeDownInventoryToNrv(org.orgId, actor, { ...common, date: "2026-07-16", nrvPerUnit: "6" });
      const date = timing === "before source" || timing === "mixed future source" ? "2026-07-15" : timing === "same day" ? "2026-07-16" : timing === "later day" ? "2026-07-17" : "2026-02-30";
      const reverse = () => reverseInventoryWritedown(org.orgId, actor, { ...common, date, nrvPerUnit: "10" });
      const snapshot = async () => (await db.execute(sql`
        select (select jsonb_agg(to_jsonb(w) order by id) from inventory_writedowns w where org_id=${org.orgId}) as writedowns,
               (select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${org.orgId}) as layers,
               (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries
      `)).rows;
      if (timing === "same day" || timing === "later day") {
        const result = await reverse();
        assert.equal(result.amount, "40.0000");
        assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "100.0000");
      } else {
        const before = await snapshot();
        await assert.rejects(reverse, InventoryNrvError);
        assert.deepEqual(await snapshot(), before);
        assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "60.0000");
      }
    } finally { await dropScratchOrg(org.orgId); }
  });
}
