import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import pg from 'pg'

const authzKey = Symbol.for('openbooks.insights-home-resolver-test')
interface AuthzState {
  authz: { user: { orgId: string; id: string; isSuperAdmin: boolean }; permissions: Set<string>; allowedSubsidiaryIds: null } | null
}
const authzState: AuthzState = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[authzKey] = authzState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.insights-home-resolver-test')]
  export async function getAuthz() { return state.authz }
`
const root = pathToFileURL(process.cwd() + '/').href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '@/lib/authz') return { url: 'mock:insights-test-authz', shortCircuit: true }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(root + 'web/' + specifier.slice(2) + '.ts').href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:insights-test-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})
const { resolveHomeDashboard } = await import('./_lib.ts')
hooks.deregister()

const databaseUrl = process.env.OPENBOOKS_DB_URL
const migrationSql = await import('node:fs').then(({ readFileSync }) =>
  readFileSync('schema/migrations/generated/0067_insights_home_uniqueness.sql', 'utf8'),
)
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')

test('stored home resolution prefers personal, then role, then system dashboards', { skip: !databaseUrl }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId))
    const personalId = randomUUID()
    const roleId = randomUUID()
    const systemId = randomUUID()
    authzState.authz = {
      user: { orgId: org.orgId, id: adminId, isSuperAdmin: true },
      permissions: new Set(['*']),
      allowedSubsidiaryIds: null,
    }

    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into insight_dashboards (id, org_id, name, status, is_home, home_for_role)
      values (${personalId}, ${org.orgId}, 'personal home', 'published', false, null),
             (${roleId}, ${org.orgId}, 'manager home', 'published', false, 'manager'),
             (${systemId}, ${org.orgId}, 'system home', 'published', true, null)
    `))
    await withOrgContext(org.orgId, () => db.execute(sql`
      update users set home_dashboard_id = ${personalId} where id = ${adminId} and org_id = ${org.orgId}
    `))

    assert.deepEqual(await withOrgContext(org.orgId, () => resolveHomeDashboard(org.orgId, adminId, 'manager')),
      { dashboardId: personalId, source: 'personal' })

    await withOrgContext(org.orgId, () => db.execute(sql`
      update users set home_dashboard_id = null where id = ${adminId} and org_id = ${org.orgId}
    `))
    assert.deepEqual(await withOrgContext(org.orgId, () => resolveHomeDashboard(org.orgId, adminId, 'manager')),
      { dashboardId: roleId, source: 'role' })

    await withOrgContext(org.orgId, () => db.execute(sql`
      update insight_dashboards set home_for_role = null where id = ${roleId} and org_id = ${org.orgId}
    `))
    assert.deepEqual(await withOrgContext(org.orgId, () => resolveHomeDashboard(org.orgId, adminId, 'manager')),
      { dashboardId: systemId, source: 'system' })
    assert.equal(await withOrgContext(org.orgId, () => resolveHomeDashboard(org.orgId, randomUUID(), 'manager')),
      null, 'a caller outside the authenticated identity has no resolved home')
  } finally {
    authzState.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('live PostgreSQL partial indexes enforce their predicates', { skip: !databaseUrl }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query("select set_config('app.bypass_rls','on',false)")
  const ids: string[] = []
  try {
    const org = (await client.query<{ id: string }>('select id from orgs order by id limit 1')).rows[0]
    assert.ok(org, 'the bootstrapped test database must contain an organization')
    const insert = (id: string, isHome: boolean, homeForRole: string | null) => client.query(
      `insert into insight_dashboards (id, org_id, name, status, is_home, home_for_role)
       values ($1, $2, $3, 'published', $4, $5)`,
      [id, org.id, `home-pointer-${id}`, isHome, homeForRole],
    )
    const id = () => { const value = randomUUID(); ids.push(value); return value }

    await insert(id(), false, null)
    await insert(id(), false, null)
    await insert(id(), false, 'manager')
    await assert.rejects(insert(id(), false, 'manager'), (error: unknown) =>
      (error as { code?: string }).code === '23505',
      'the database must reject a second row for the same organization and role',
    )
    await insert(id(), true, null)
    await assert.rejects(insert(id(), true, null), (error: unknown) =>
      (error as { code?: string }).code === '23505',
      'the database must reject a second system-home row for the organization',
    )
  } finally {
    await client.query('delete from insight_dashboards where id = any($1::uuid[])', [ids]).catch(() => {})
    await client.end()
  }
})

test('live PostgreSQL migration repairs duplicate pointers and replays without changing the result', { skip: !databaseUrl }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query("select set_config('app.bypass_rls','on',false)")
  const idPrefix = randomUUID().slice(0, 24)
  const ids = Array.from({ length: 5 }, (_, index) => `${idPrefix}${String(index + 1).padStart(12, '0')}`)
  let transactionOpen = false
  try {
    const org = (await client.query<{ id: string }>('select id from orgs order by id limit 1')).rows[0]
    assert.ok(org, 'the bootstrapped test database must contain an organization')
    await client.query('begin')
    transactionOpen = true
    await client.query('drop index public.insight_dashboards_org_home')
    await client.query('drop index public.insight_dashboards_org_role_home')
    await client.query(
      `insert into insight_dashboards (id, org_id, name, status, is_home, home_for_role, updated_at)
       values ($1, $6, 'legacy-system-old', 'draft', true, null, '2026-08-01T00:00:00Z'),
              ($2, $6, 'legacy-system-new', 'draft', true, null, '2026-08-02T00:00:00Z'),
              ($3, $6, 'legacy-role-old', 'draft', false, 'manager', '2026-08-03T00:00:00Z'),
              ($4, $6, 'legacy-role-new', 'draft', false, 'manager', '2026-08-03T00:00:00Z'),
              ($5, $6, 'legacy-ordinary', 'draft', false, null, '2026-08-01T00:00:00Z')`,
      [...ids, org.id],
    )

    await client.query(migrationSql)
    const query = 'select id, is_home, home_for_role from insight_dashboards where id = any($1::uuid[]) order by id'
    const once = await client.query(query, [ids])
    assert.deepEqual(once.rows, [
      { id: ids[0], is_home: false, home_for_role: null },
      { id: ids[1], is_home: true, home_for_role: null },
      { id: ids[2], is_home: false, home_for_role: null },
      { id: ids[3], is_home: false, home_for_role: 'manager' },
      { id: ids[4], is_home: false, home_for_role: null },
    ])

    await client.query(migrationSql)
    const twice = await client.query(query, [ids])
    assert.deepEqual(twice.rows, once.rows)
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => {})
    await client.end()
  }
})
