import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const policy of ["account", "inactive subsidiary", "inactive book", "non-posting book"] as const) {
  test(`FX revaluation refuses ${policy} before its adjustment/reversal pair`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
    try {
      const actorId=(await seedFlowActors(org.orgId)).adminId;
      const branchId=randomUUID(),entryId=randomUUID();
      await db.execute(sql`insert into accounting_periods
        (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        select ${randomUUID()},${org.orgId},2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id
        from accounting_periods where id=${org.periodId}`);
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${branchId},${org.orgId},${org.subsidiaryId},'FX policy branch','CAD','CA')`);
      const subsidiaryId=policy === "inactive subsidiary" ? branchId : org.subsidiaryId;
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',
        coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('fxUnrealizedGainLoss',${org.accounts.fxGainLoss}::text))
        where id=${org.orgId}`);
      await db.execute(sql`insert into fx_rates(org_id,from_currency,to_currency,as_of,rate_type,rate)
        values(${org.orgId},'USD','CAD','2026-07-31','spot',1.37)`);
      await db.execute(sql`insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,created_by,updated_by)
        values(${entryId},${org.orgId},${org.bookId},${subsidiaryId},'FX-POLICY','2026-07-10',${org.periodId},'draft','manual',${actorId},${actorId})`);
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,is_open_item)
        values(${org.orgId},${entryId},1,${org.accounts.ar},${subsidiaryId},136,'USD',100,1.36,false),
          (${org.orgId},${entryId},2,${org.accounts.clearing},${subsidiaryId},-136,'CAD',-136,1,false)`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actorId}
        where org_id=${org.orgId} and id=${entryId}`);
      if(policy === "account") await db.execute(sql`update accounts set subsidiary_id=${branchId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.accounts.fxGainLoss}`);
      if(policy === "inactive subsidiary") await db.execute(sql`update subsidiaries set is_active=false where org_id=${org.orgId} and id=${branchId}`);
      if(policy === "inactive book") await db.execute(sql`update accounting_books set is_active=false where org_id=${org.orgId} and id=${org.bookId}`);
      if(policy === "non-posting book") await db.execute(sql`update accounting_books set posts_gl=false where org_id=${org.orgId} and id=${org.bookId}`);
      const run=()=>runRevaluation(org.orgId,org.periodId,actorId,[subsidiaryId]);
      const refused=await run();
      assert.equal(refused.posted.length,0);
      assert.equal(refused.problems.length,1);
      assert.match(refused.problems[0]!,policy === "account" ? /restricted to another subsidiary/
        : policy === "inactive subsidiary" ? /inactive/ : /active primary posting book/);
      assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n,1);
      await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${org.accounts.fxGainLoss}`);
      await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${branchId}`);
      await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      const posted=await run();
      assert.equal(posted.posted.length,1);
      assert.equal(posted.problems.length,0);
      assert.equal((await run()).posted.length,0);
    } finally {await dropScratchOrg(org.orgId);}
  });
}
