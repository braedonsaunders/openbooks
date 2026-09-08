import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { getOnHand, receiveInventory } from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const operation of ["write-down", "recovery"] as const) {
  for (const policy of (operation === "write-down"
    ? ["account restriction", "inactive owner", "later owner restriction"] as const
    : ["account restriction", "inactive owner"] as const)) {
    test(`NRV ${operation} enforces ${policy}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        await db.execute(sql`update orgs set settings=settings||'{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
        const ownerId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${ownerId},${org.orgId},${org.subsidiaryId},'Stock owner','CAD','CA')`);
        await receiveInventory(org.orgId, actorId, {
          itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: ownerId,
          quantity: "10", unitCost: "5", offsetAccountId: org.accounts.clearing, date: org.date,
        });
        const input = { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
          subsidiaryId: ownerId, date: org.date, nrvPerUnit: "4" };
        if (operation === "recovery") await writeDownInventoryToNrv(org.orgId, actorId, input);
        const siblingId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${siblingId},${org.orgId},${org.subsidiaryId},'Other inventory owner','CAD','CA')`);
        if (policy === "later owner restriction") await receiveInventory(org.orgId, actorId, {
          itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: siblingId,
          quantity: "10", unitCost: "5", offsetAccountId: org.accounts.clearing, date: org.date,
        });
        const before = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
        const accountId = (await db.execute<{ id: string }>(sql`
          select asset_account_id as id from item_inventory_profiles where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows[0]!.id;
        if (policy === "account restriction") await db.execute(sql`update accounts set subsidiary_id=${siblingId},subsidiary_include_children=false
          where org_id=${org.orgId} and id=${accountId}`);
        else if (policy === "later owner restriction") await db.execute(sql`update accounts set subsidiary_id=${ownerId},subsidiary_include_children=false
          where org_id=${org.orgId} and id=${accountId}`);
        else await db.execute(sql`update subsidiaries set is_active=false where org_id=${org.orgId} and id=${ownerId}`);
        const run = () => operation === "write-down" ? writeDownInventoryToNrv(org.orgId, actorId, input)
          : reverseInventoryWritedown(org.orgId, actorId, { ...input, nrvPerUnit: "5" });
        await withOrgTransaction(org.orgId, async () => {
          await assert.rejects(run(), policy === "inactive owner" ? /inactive/ : /restricted to another subsidiary/);
          assert.deepEqual(await getOnHand(org.orgId, org.items.fifo, org.stockLocationId), before);
        });
        const counts = (await db.execute<{ journals: number; writedowns: number; reversed: string }>(sql`select
          (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from inventory_writedowns where org_id=${org.orgId}) as writedowns,
          (select coalesce(sum(reversed_amount),0)::text from inventory_writedowns where org_id=${org.orgId}) as reversed`)).rows[0]!;
        assert.equal(counts.journals, operation === "recovery" || policy === "later owner restriction" ? 2 : 1);
        assert.equal(counts.writedowns, operation === "recovery" ? 1 : 0);
        assert.match(counts.reversed, /^0(?:\.0+)?$/);
        await db.execute(sql`update accounts set subsidiary_id=null where org_id=${org.orgId} and id=${accountId}`);
        await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${ownerId}`);
        assert.ok((await run()).entryId);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
