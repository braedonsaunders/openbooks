import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

for (const policy of ["inactive receipt offset", "inactive asset account", "inactive issue offset"] as const) {
  test(`inventory posting refuses ${policy}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      if (policy === "inactive issue offset") {
        await receiveInventory(org.orgId, actorId, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          quantity: "10",
          unitCost: "5",
          subsidiaryId: org.subsidiaryId,
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        });
        await db.execute(sql`update accounts set is_active=false
          where org_id=${org.orgId} and id=${org.accounts.cogs}`);
      } else {
        const accountId = policy === "inactive receipt offset" ? org.accounts.clearing : org.accounts.invAsset;
        await db.execute(sql`update accounts set is_active=false
          where org_id=${org.orgId} and id=${accountId}`);
      }

      const before = (await db.execute<{ journals: number; movements: number; layers: number }>(sql`
        select
          (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from inventory_movements where org_id=${org.orgId}) as movements,
          (select count(*)::int from cost_layers where org_id=${org.orgId}) as layers
      `)).rows[0]!;
      const run = policy === "inactive issue offset"
        ? issueInventory(org.orgId, actorId, {
            itemId: org.items.fifo,
            stockLocationId: org.stockLocationId,
            quantity: "1",
            subsidiaryId: org.subsidiaryId,
            date: org.date,
          })
        : receiveInventory(org.orgId, actorId, {
            itemId: org.items.fifo,
            stockLocationId: org.stockLocationId,
            quantity: "10",
            unitCost: "5",
            subsidiaryId: org.subsidiaryId,
            offsetAccountId: org.accounts.clearing,
            date: org.date,
          });
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof InventoryError);
        assert.match(error.message, /inactive|summary/i);
        return true;
      });
      const after = (await db.execute<{ journals: number; movements: number; layers: number }>(sql`
        select
          (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from inventory_movements where org_id=${org.orgId}) as movements,
          (select count(*)::int from cost_layers where org_id=${org.orgId}) as layers
      `)).rows[0]!;
      assert.deepEqual(after, before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
