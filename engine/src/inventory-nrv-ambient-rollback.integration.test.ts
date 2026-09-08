import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { getOnHand, receiveInventory } from "./inventory.ts";
import { writeDownInventoryToNrv, reverseInventoryWritedown } from "./inventory-nrv.ts";
import { createScratchOrg,dropScratchOrg,seedFlowActors } from "./test-fixtures.ts";

for(const scenario of ["missing period","disabled book","reversal book"] as const){
  test(`NRV refusal rolls back its layer change inside a caller transaction: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try{
      const actorId=(await seedFlowActors(org.orgId)).adminId;
      await receiveInventory(org.orgId,actorId,{itemId:org.items.fifo,stockLocationId:org.stockLocationId,
        subsidiaryId:org.subsidiaryId,quantity:"10",unitCost:"5",offsetAccountId:org.accounts.clearing,date:org.date});
      const nrvInput={itemId:org.items.fifo,stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,nrvPerUnit:"4",date:org.date};
      if(scenario === "reversal book"){
        await db.execute(sql`update orgs set settings=settings||'{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
        await writeDownInventoryToNrv(org.orgId,actorId,nrvInput);
      }
      const before=await getOnHand(org.orgId,org.items.fifo,org.stockLocationId);
      if(scenario !== "missing period")await db.execute(sql`update accounting_books set posts_gl=false where org_id=${org.orgId} and id=${org.bookId}`);
      await withOrgTransaction(org.orgId,async()=>{
        await db.execute(sql`update parties set display_name='Surviving NRV caller' where org_id=${org.orgId} and id=${org.customerId}`);
        const operation=scenario === "reversal book"
          ? reverseInventoryWritedown(org.orgId,actorId,{...nrvInput,nrvPerUnit:"5"})
          : writeDownInventoryToNrv(org.orgId,actorId,{...nrvInput,date:scenario === "missing period" ? "2030-01-15" : org.date});
        await assert.rejects(operation,scenario === "missing period" ? /no accounting period/ : /active posting book/);
        assert.deepEqual(await getOnHand(org.orgId,org.items.fifo,org.stockLocationId),before,"a caught refusal cannot reduce inventory value");
      });
      assert.deepEqual(await getOnHand(org.orgId,org.items.fifo,org.stockLocationId),before);
      const caller=(await db.execute<{name:string}>(sql`select display_name as name from parties where org_id=${org.orgId} and id=${org.customerId}`)).rows[0]!;
      assert.equal(caller.name,"Surviving NRV caller");
      const counts=(await db.execute<{journals:number;writedowns:number}>(sql`select
        (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
        (select count(*)::int from inventory_writedowns where org_id=${org.orgId}) as writedowns`)).rows[0]!;
      assert.deepEqual(counts,{journals:scenario === "reversal book" ? 2 : 1,writedowns:scenario === "reversal book" ? 1 : 0});
      const restored=(await db.execute<{amount:string}>(sql`select coalesce(sum(reversed_amount),0)::text as amount
        from inventory_writedowns where org_id=${org.orgId}`)).rows[0]!;
      assert.match(restored.amount,/^0(?:\.0+)?$/,"failed recovery cannot consume reversal headroom");
    }finally{await dropScratchOrg(org.orgId);}
  });
}
