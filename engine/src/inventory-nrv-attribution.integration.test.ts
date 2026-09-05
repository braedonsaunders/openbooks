import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, seedFlowActors, dropScratchOrg } from "./test-fixtures.ts";
import { receiveInventory } from "./inventory.ts";
import { writeDownInventoryToNrv, reverseInventoryWritedown } from "./inventory-nrv.ts";

for (const operation of ["write-down", "reversal"] as const) {
  test(`NRV journal attribution: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
      await receiveInventory(org.orgId, actor, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "10",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const common = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date };
      let result = await writeDownInventoryToNrv(org.orgId, actor, { ...common, nrvPerUnit: "6" });
      if (operation === "reversal") result = await reverseInventoryWritedown(org.orgId, actor, { ...common, nrvPerUnit: "10" });
      for (const entity of result.entities) {
        const evidence = (await db.execute(sql`
          select e.created_by, e.updated_by, e.posted_by, w.created_by as evidence_actor
          from journal_entries e join inventory_writedowns w on w.journal_entry_id=e.id and w.org_id=e.org_id
          where e.org_id=${org.orgId} and e.id=${entity.entryId}
        `)).rows;
        assert.deepEqual(evidence, [{ created_by: actor, updated_by: actor, posted_by: actor, evidence_actor: actor }]);
      }
    } finally { await dropScratchOrg(org.orgId); }
  });
}
