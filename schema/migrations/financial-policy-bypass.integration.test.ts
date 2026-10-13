import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { withBypassContext } from "@openbooks/engine/platform/db";
import { createScratchOrg,dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const tables=["fx_rate_types","account_translation_policies","subsidiary_accounting_preferences",
  "journal_reversal_instructions","segment_balancing_policies","gl_audit_number_policies","gl_audit_number_assignments"];
test("financial policy migration refuses drift and a runtime bypass setting cannot widen tenant access", {
  skip:!process.env.OPENBOOKS_TEST_ADMIN_DB_URL || !process.env.OPENBOOKS_RUNTIME_DB_URL,
},async()=>{
  const adminUrl=process.env.OPENBOOKS_TEST_ADMIN_DB_URL!;
  assert.match(new URL(adminUrl).pathname,/^\/ob_/);
  const admin=new pg.Client({connectionString:adminUrl});
  const runtime=new pg.Client({connectionString:process.env.OPENBOOKS_RUNTIME_DB_URL});
  const first=await withBypassContext(()=>createScratchOrg());
  const second=await withBypassContext(()=>createScratchOrg());
  const preflight=readFileSync("schema/migrations/preflight/0707_financial_policy_bypass_predicate.sql","utf8");
  const migration=readFileSync("schema/migrations/generated/0707_financial_policy_bypass_predicate.sql","utf8");
  try {
    await admin.connect();await runtime.connect();
    assert.deepEqual((await admin.query(preflight)).rows,[]);
    const policies=(await admin.query(`select tablename,qual,with_check from pg_policies
      where schemaname='public' and tablename=any($1::text[]) order by tablename`,[tables])).rows;
    assert.equal(policies.length,7);
    for(const policy of policies) {
      assert.match(policy.qual,/SELECT app_bypass_rls_active/);
      assert.equal(policy.qual,policy.with_check);
      assert.equal(policy.qual.includes("app.bypass_rls"),false);
    }
    await runtime.query("select set_config('app.current_org','',false),set_config('app.bypass_rls','on',false)");
    assert.equal((await runtime.query("select count(*)::integer as n from fx_rate_types")).rows[0].n,0);
    await runtime.query("select set_config('app.current_org',$1,false)",[first.orgId]);
    const rows=(await runtime.query("select distinct org_id::text from fx_rate_types")).rows;
    assert.deepEqual(rows,[{org_id:first.orgId}]);
    await assert.rejects(runtime.query("insert into fx_rate_types(org_id,key,name,is_active) values($1,$2,'Foreign rate',true)",
      [second.orgId,`foreign_${randomUUID().replaceAll('-','')}`]),/row-level security/);
    await admin.query("begin");
    await admin.query("drop policy org_isolation on public.fx_rate_types");
    await admin.query("create policy org_isolation on public.fx_rate_types using(true) with check(true)");
    const findings=(await admin.query(preflight)).rows;
    assert.equal(findings.length,1);assert.equal(findings[0].subject,"public.fx_rate_types");
    await assert.rejects(admin.query(migration),/database-owner reconciliation/);
    await admin.query("rollback");
    assert.deepEqual((await admin.query(preflight)).rows,[]);
  } finally {
    await runtime.end();await admin.query("rollback").catch(()=>{});await admin.end();
    await withBypassContext(()=>dropScratchOrg(second.orgId));
    await withBypassContext(()=>dropScratchOrg(first.orgId));
  }
});
