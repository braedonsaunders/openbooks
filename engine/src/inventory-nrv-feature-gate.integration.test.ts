import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { getOnHand, receiveInventory } from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const operation of ["write-down", "recovery"] as const) {
  test(`disabled Inventory preserves NRV ${operation} data`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update orgs set settings=settings||'{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
      await receiveInventory(org.orgId, actorId, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId, quantity: "10", unitCost: "5", offsetAccountId: org.accounts.clearing, date: org.date });
      const input = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, nrvPerUnit: "4", date: org.date };
      if (operation === "recovery") await writeDownInventoryToNrv(org.orgId, actorId, input);
      const before = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
      const evidence = async () => (await db.execute(sql`select id,kind,amount,reversed_amount,journal_entry_id from inventory_writedowns where org_id=${org.orgId} order by id`)).rows;
      const historical = await evidence();
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`);
      const run = () => operation === "write-down" ? writeDownInventoryToNrv(org.orgId, actorId, input)
        : reverseInventoryWritedown(org.orgId, actorId, { ...input, nrvPerUnit: "5" });
      await assert.rejects(run(), /inventory feature is disabled/i);
      assert.deepEqual(await getOnHand(org.orgId, org.items.fifo, org.stockLocationId), before);
      assert.deepEqual(await evidence(), historical);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','true'::jsonb) where id=${org.orgId}`);
      assert.ok((await run()).entryId);
    } finally { await dropScratchOrg(org.orgId); }
  });
}
