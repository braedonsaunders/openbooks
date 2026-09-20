import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { receiveInventory, reverseInventoryMovement } from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

for (const policy of ["inactive book", "account restriction", "inactive owner"] as const) {
  test(`inventory reversal rechecks current posting policy: ${policy}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      let ownerId = org.subsidiaryId;
      if (policy === "inactive owner") {
        ownerId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${ownerId},${org.orgId},${org.subsidiaryId},'Inventory reversal owner','CAD','CA')`);
      }
      const receipt = await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "5",
        subsidiaryId: ownerId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const snapshot = async () => (await db.execute(sql`
        select
          (select jsonb_agg(to_jsonb(m) order by id) from inventory_movements m where org_id=${org.orgId}) as movements,
          (select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${org.orgId}) as layers,
          (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries
      `)).rows[0];
      const before = await snapshot();

      if (policy === "inactive book") {
        await db.execute(sql`update accounting_books set is_active=false
          where org_id=${org.orgId} and id=${org.bookId}`);
      } else if (policy === "account restriction") {
        const siblingId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${siblingId},${org.orgId},${org.subsidiaryId},'Inventory reversal sibling','CAD','CA')`);
        await db.execute(sql`update accounts set subsidiary_id=${siblingId},subsidiary_include_children=false
          where org_id=${org.orgId} and id=${org.accounts.invAsset}`);
      } else {
        await db.execute(sql`update subsidiaries set is_active=false
          where org_id=${org.orgId} and id=${ownerId}`);
      }

      await assert.rejects(
        reverseInventoryMovement(org.orgId, actorId, {
          movementId: receipt.movementId,
          reversalDate: org.date,
          reason: "Reverse after posting policy changed",
        }),
        policy === "inactive book" ? /active.*posting book|book.*active/i
          : policy === "inactive owner" ? /inactive/i
          : /restricted to another subsidiary/,
      );
      assert.deepEqual(await snapshot(), before, "refusal must preserve inventory and journal evidence");

      if (policy === "inactive book") {
        await db.execute(sql`update accounting_books set is_active=true
          where org_id=${org.orgId} and id=${org.bookId}`);
      } else if (policy === "account restriction") {
        await db.execute(sql`update accounts set subsidiary_id=null,subsidiary_include_children=true
          where org_id=${org.orgId} and id=${org.accounts.invAsset}`);
      } else {
        await db.execute(sql`update subsidiaries set is_active=true
          where org_id=${org.orgId} and id=${ownerId}`);
      }

      const reversed = await reverseInventoryMovement(org.orgId, actorId, {
        movementId: receipt.movementId,
        reversalDate: org.date,
        reason: "Reverse after posting policy restored",
      });
      assert.equal(reversed.alreadyReversed, false);
      assert.ok(reversed.entryId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
