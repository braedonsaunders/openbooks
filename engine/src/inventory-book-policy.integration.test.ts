import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { getOnHand, issueInventory, receiveInventory } from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const operation of ["receipt", "issue"] as const) {
  for (const flag of ["is_active", "posts_gl"] as const) {
    test(`inventory ${operation} refuses primary ${flag}=false without changing stock`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await createScratchOrg();
      try {
        const actorId=(await seedFlowActors(org.orgId)).adminId;
        const input={itemId:org.items.fifo,stockLocationId:org.stockLocationId,subsidiaryId:org.subsidiaryId,
          quantity:"10",unitCost:"5",offsetAccountId:org.accounts.clearing,date:org.date};
        if(operation === "issue") await receiveInventory(org.orgId,actorId,input);
        const before=await getOnHand(org.orgId,org.items.fifo,org.stockLocationId);
        await db.execute(sql`update accounting_books set ${sql.raw(flag)}=false where org_id=${org.orgId} and id=${org.bookId}`);
        const run=()=>operation === "receipt" ? receiveInventory(org.orgId,actorId,input)
          : issueInventory(org.orgId,actorId,{...input,quantity:"5",offsetAccountId:org.accounts.cogs});
        await assert.rejects(run(),/active primary posting book/);
        assert.deepEqual(await getOnHand(org.orgId,org.items.fifo,org.stockLocationId),before);
        const state=(await db.execute<{journals:number;movements:number}>(sql`
          select (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
            (select count(*)::int from inventory_movements where org_id=${org.orgId}) as movements`)).rows[0]!;
        const baseline=operation === "issue" ? 1 : 0;
        assert.deepEqual(state,{journals:baseline,movements:baseline});
        await db.execute(sql`update accounting_books set ${sql.raw(flag)}=true where org_id=${org.orgId} and id=${org.bookId}`);
        assert.ok((await run()).entryId);
      } finally {await dropScratchOrg(org.orgId);}
    });
  }
}

test("inventory receipt waits for a book edit and refuses without leaving stock fragments",{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  const writer=await pool.connect();
  let pending:Promise<PromiseSettledResult<Awaited<ReturnType<typeof receiveInventory>>>>|undefined;
  try {
    const actorId=(await seedFlowActors(org.orgId)).adminId;
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update accounting_books set posts_gl=false where org_id=$1 and id=$2",[org.orgId,org.bookId]);
    const pid=(await writer.query<{pid:number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending=receiveInventory(org.orgId,actorId,{itemId:org.items.fifo,stockLocationId:org.stockLocationId,
      subsidiaryId:org.subsidiaryId,quantity:"10",unitCost:"5",offsetAccountId:org.accounts.clearing,date:org.date})
      .then((value)=>({status:"fulfilled",value}),(reason:unknown)=>({status:"rejected",reason}));
    let blocked=false;
    for(let attempt=0;attempt<400;attempt++){
      const count=(await pool.query<{n:number}>(
        "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",[pid])).rows[0]!.n;
      if(count){blocked=true;break;}
      await new Promise((resolve)=>setTimeout(resolve,10));
    }
    assert.ok(blocked,"receipt must wait for the accounting book policy");
    await writer.query("commit");
    const result=await pending;
    assert.equal(result.status,"rejected");
    if(result.status!=="rejected") assert.fail("disabled posting book must refuse receipt");
    assert.ok(result.reason instanceof Error);
    assert.match(result.reason.message,/active primary posting book/);
    const counts=(await db.execute<{journals:number;movements:number;layers:number}>(sql`
      select (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
        (select count(*)::int from inventory_movements where org_id=${org.orgId}) as movements,
        (select count(*)::int from cost_layers where org_id=${org.orgId}) as layers`)).rows[0]!;
    assert.deepEqual(counts,{journals:0,movements:0,layers:0});
  }finally{
    await writer.query("rollback");
    writer.release();
    await pending;
    await dropScratchOrg(org.orgId);
  }
});
