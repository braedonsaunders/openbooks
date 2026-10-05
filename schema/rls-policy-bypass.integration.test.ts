import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { db, withBypassContext } from '../engine/src/platform/db.ts';
import { createScratchOrg, dropScratchOrg } from '../engine/src/testing/fixtures.ts';

const DB = { skip: !process.env.OPENBOOKS_DB_URL || !process.env.OPENBOOKS_RUNTIME_DB_URL || !process.env.OPENBOOKS_TEST_ADMIN_DB_URL };
const backstop = readFileSync(new URL('./migrations/environments.sql', import.meta.url), 'utf8');

test('runtime login cannot forge a tenant bypass on payroll expenses or payment disputes', DB, async () => {
  const first = await createScratchOrg(), second = await createScratchOrg();
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_RUNTIME_DB_URL });
  try {
    const fixtures = [];
    for (const org of [first, second]) fixtures.push(await withBypassContext(async () => {
      const component = (await db.execute<{ id: string }>(sql`insert into pay_components (org_id,code,name,kind) values (${org.orgId},'DEPT-EARNING','Department earning','earning') returning id`)).rows[0]!.id;
      const department = (await db.execute<{ id: string }>(sql`insert into departments (org_id,name) values (${org.orgId},'Operations') returning id`)).rows[0]!.id;
      await db.execute(sql`insert into pay_component_department_expenses (org_id,pay_component_id,department_id,expense_account_id,effective_from) values (${org.orgId},${component},${department},${org.accounts.cogs},${org.date})`);
      await db.execute(sql`insert into payment_disputes (org_id,provider,provider_event_id,kind,status,currency,amount) values (${org.orgId},'stripe','evt-test','dispute','opened','CAD','10')`);
      return { org, component, department };
    }));
    await client.connect();
    const role = (await client.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    await client.query("select set_config('app.current_org',$1,false),set_config('app.bypass_rls','on',false)", [first.orgId]);
    assert.equal((await client.query('select public.app_bypass_rls_active() active')).rows[0].active, false);
    for (const table of ['pay_component_department_expenses','payment_disputes']) {
      const read = await client.query(`select org_id from public.${table} where org_id=any($1::uuid[])`, [[first.orgId,second.orgId]]);
      assert.deepEqual(read.rows, [{ org_id: first.orgId }], `${table} must honor the tenant despite a forged bypass flag`);
      assert.equal((await client.query(`update public.${table} set updated_at=now() where org_id=$1`, [second.orgId])).rowCount, 0);
    }
    const other = fixtures[1]!;
    await assert.rejects(client.query('insert into pay_component_department_expenses (org_id,pay_component_id,department_id,expense_account_id,effective_from) values ($1,$2,$3,$4,$5)', [second.orgId,other.component,other.department,second.accounts.cogs,'2030-01-01']), (e: unknown) => (e as {code: string}).code === '42501');
    await assert.rejects(client.query("insert into payment_disputes (org_id,provider,provider_event_id,kind,status,currency,amount) values ($1,'stripe','evt-cross','dispute','opened','CAD','10')", [second.orgId]), (e: unknown) => (e as {code: string}).code === '42501');
  } finally { await client.end(); await dropScratchOrg(second.orgId); await dropScratchOrg(first.orgId); }
});

test('bootstrap repairs an unsafe expression carrying the current policy version comment', DB, async () => {
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  try {
    await client.connect(); await client.query('begin');
    await client.query("drop policy org_isolation on payment_disputes; create policy org_isolation on payment_disputes using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (true); comment on policy org_isolation on payment_disputes is 'openbooks:org_isolation:v1'");
    await client.query(backstop);
    const policy = (await client.query("select qual,with_check from pg_policies where schemaname='public' and tablename='payment_disputes' and policyname='org_isolation'")).rows[0];
    assert.match(policy.qual, /app_bypass_rls_active/);
    assert.equal(policy.qual, policy.with_check);
    assert.doesNotMatch(policy.qual, /app\.bypass_rls/);
    await client.query(backstop);
    const unsafe = await client.query("select tablename,policyname from pg_policies where schemaname='public' and (qual like '%app.bypass_rls%' or with_check like '%app.bypass_rls%')");
    assert.deepEqual(unsafe.rows, []);
  } finally { await client.query('rollback'); await client.end(); }
});

test('bootstrap refuses an additional unsafe permissive policy rather than masking it', DB, async () => {
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  try {
    await client.connect(); await client.query('begin');
    await client.query("create policy unsafe_expense_bypass on pay_component_department_expenses using (current_setting('app.bypass_rls',true)='on') with check (true)");
    await assert.rejects(client.query(backstop), /pay_component_department_expenses\.unsafe_expense_bypass.*apply the forward tenant-policy repair migration/);
  } finally { await client.query('rollback'); await client.end(); }
});
