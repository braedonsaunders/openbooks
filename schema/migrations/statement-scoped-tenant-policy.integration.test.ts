import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

test('statement-scoped policy checks preserve runtime isolation and are evaluated once', {
  skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL || !process.env.OPENBOOKS_RUNTIME_DB_URL,
}, async () => {
  const adminUrl = process.env.OPENBOOKS_TEST_ADMIN_DB_URL!
  assert.match(new URL(adminUrl).pathname, /^\/ob_/, 'policy conformance must use a disposable test database')
  const admin = new pg.Client({ connectionString: adminUrl })
  const runtime = new pg.Client({ connectionString: process.env.OPENBOOKS_RUNTIME_DB_URL })
  const table = `audit_policy_${randomUUID().replaceAll('-', '')}`
  const orgA = randomUUID(), orgB = randomUUID()
  const migration = readFileSync('schema/migrations/generated/0467_statement_scoped_tenant_policy_checks.sql', 'utf8')
  try {
    await admin.connect()
    await runtime.connect()
    const role = (await runtime.query('select current_user as role')).rows[0].role as string
    assert.match(role, /^[a-z_][a-z0-9_]*$/)
    await admin.query(`create table public.${table} (org_id uuid not null, n integer not null)`)
    await admin.query(`insert into public.${table} select $1::uuid,n from generate_series(1,10000) n`, [orgA])
    await admin.query(`insert into public.${table} values ($1,10001)`, [orgB])
    await admin.query(`alter table public.${table} enable row level security`)
    await admin.query(`alter table public.${table} force row level security`)
    await admin.query(`grant select,insert,update,delete on public.${table} to ${role}`)
    await admin.query(`create policy tenant_scope on public.${table}
      using (public.app_bypass_rls_active() or org_id::text=current_setting('app.current_org',true))
      with check (public.app_bypass_rls_active() or org_id::text=current_setting('app.current_org',true))`)
    const policyQuery = `select polcmd,polroles,polpermissive,pg_get_expr(polqual,polrelid) as predicate,
      pg_get_expr(polwithcheck,polrelid) as check_predicate from pg_policy where polrelid=$1::regclass`
    const before = (await admin.query(policyQuery, [`public.${table}`])).rows[0]
    await admin.query('begin')
    await admin.query(migration)
    const after = (await admin.query(policyQuery, [`public.${table}`])).rows[0]
    assert.deepEqual([after.polcmd, after.polroles, after.polpermissive], [before.polcmd, before.polroles, before.polpermissive])
    assert.match(after.predicate, /SELECT app_bypass_rls_active/)
    assert.match(after.check_predicate, /SELECT app_bypass_rls_active/)
    assert.match(after.predicate, /SELECT current_setting/)
    assert.match(after.check_predicate, /SELECT current_setting/)
    await admin.query(migration)
    assert.deepEqual((await admin.query(policyQuery, [`public.${table}`])).rows[0], after)
    await admin.query('commit')
    // Bootstrap must also generate efficient policies for newly created tables.
    await admin.query(readFileSync('schema/migrations/environments.sql', 'utf8'))
    const generated = (await admin.query(policyQuery + " and polname='org_isolation'", [`public.${table}`])).rows[0]
    assert.match(generated.predicate, /SELECT app_bypass_rls_active/)
    assert.match(generated.predicate, /SELECT current_setting/)
    assert.match(generated.check_predicate, /SELECT app_bypass_rls_active/)

    const count = async (org: string, bypass: string) => {
      await runtime.query("select set_config('app.current_org',$1,false),set_config('app.bypass_rls',$2,false)", [org, bypass])
      return Number((await runtime.query(`select count(*) as n from public.${table}`)).rows[0].n)
    }
    assert.equal(await count('', 'off'), 0)
    assert.equal(await count('', 'on'), 0, 'a runtime GUC cannot grant cross-tenant access')
    assert.equal(await count(orgA, 'on'), 10000)
    assert.equal(await count(orgB, 'off'), 1, 'a later statement must observe its new tenant context')
    assert.equal(await count(orgA, 'off'), 10000)
    await assert.rejects(runtime.query(`insert into public.${table} values ($1,2)`, [orgB]), /row-level security/)
    assert.equal((await runtime.query(`update public.${table} set n=0 where org_id=$1`, [orgB])).rowCount, 0)
    const plan = (await runtime.query(`explain (analyze,format json) select count(*) from public.${table}`)).rows[0]['QUERY PLAN'][0].Plan
    const initPlans: Array<Record<string, unknown>> = []
    const walk = (node: Record<string, unknown>) => {
      if (node['Parent Relationship'] === 'InitPlan') initPlans.push(node)
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child)
    }
    walk(plan)
    assert.ok(initPlans.length >= 2, 'bypass and tenant context must both be InitPlans')
    assert.ok(initPlans.every((node) => node['Actual Loops'] === 1), 'the predicate must run once, not once per protected row')
  } finally {
    await runtime.end()
    await admin.query('rollback').catch(() => {})
    await admin.query(`drop table if exists public.${table}`)
    await admin.end()
  }
})
