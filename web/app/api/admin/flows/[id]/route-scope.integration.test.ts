import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../../lib/auth'

/**
 * The flows admin surfaces must not leak other subsidiaries' runs.
 *
 * GET /api/admin/flows lists org-wide run_count and last-run verdicts;
 * GET /api/admin/flows/[id] returns the 30 newest runs with subject UUIDs,
 * errors and timestamps. A subsidiary-restricted flows.manage caller sees
 * only runs whose subject sits inside their scope — counts and last-run
 * fields are computed over in-scope subjects only. Regression: two
 * entities, one flow, one run each. Only the session is stubbed; gates,
 * scope resolution and storage are real.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __adminFlowsScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__adminFlowsScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET: list } = await import('../route')
const { GET: detail } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'tester', email: `tester-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId,
    homeOrgId: orgId, homeUserId: id,
  }
}

async function enableFlows(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"flows":true}'::jsonb, true)
      where id = ${orgId}`),
  )
}

async function makeBill(orgId: string, subsidiaryId: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${'BILL-' + id.slice(0, 8)}, '2026-07-15', ${subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`))
  return id
}

async function seedFlow(orgId: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${id}, ${orgId}, 'Scoped flow', 'vendor_bill', true, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb)`))
  return id
}

async function seedRun(orgId: string, flowId: string, subjectId: string, status: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into flow_runs
      (id, org_id, flow_id, subject_kind, subject_id, trigger, status, context, started_at, created_at, updated_at)
    values (${id}, ${orgId}, ${flowId}, 'vendor_bill', ${subjectId}, 'on_submit',
            ${status}, '{}'::jsonb, now(), now(), now())`))
  return id
}

async function seedUser(
  orgId: string, key: string, permissions: string[], subsidiaryIds: string[] | null,
): Promise<void> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key))
  await withBypassContext(() => db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify(subsidiaryIds === null ? { mode: 'all' } : { mode: 'list', subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${key}`))
  state.user = sessionUser(userId, orgId)
}

test('a restricted flows.manage caller sees only in-scope runs', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFlows(org.orgId)
    const branch = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Flow Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`))
    const homeBill = await makeBill(org.orgId, org.subsidiaryId)
    const branchBill = await makeBill(org.orgId, branch)
    const flowId = await seedFlow(org.orgId)
    await seedRun(org.orgId, flowId, branchBill, 'failed')
    await seedRun(org.orgId, flowId, homeBill, 'completed')
    const params = { params: Promise.resolve({ id: flowId }) }

    await seedUser(org.orgId, 'flow_checker', ['flows.manage'], [org.subsidiaryId])

    const listed = await withOrgContext(org.orgId, () => list())
    assert.equal(listed.status, 200)
    const flows = ((await listed.json()) as { flows: Record<string, unknown>[] }).flows
    assert.equal(flows.length, 1)
    assert.equal(String(flows[0]!.run_count), '1', 'the count covers the in-scope run only')
    assert.equal(flows[0]!.last_run_status, 'completed', 'the last run is the in-scope one')

    const got = await withOrgContext(org.orgId, () =>
      detail(new Request(`http://admin.test/api/admin/flows/${flowId}`), params))
    assert.equal(got.status, 200)
    const runs = ((await got.json()) as { runs: { subject_id: string; status: string }[] }).runs
    assert.equal(runs.length, 1, 'the out-of-scope run is dropped')
    assert.equal(runs[0]!.subject_id, homeBill)
    assert.ok(!runs.some((run) => run.subject_id === branchBill), 'no branch subject leaks')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an unrestricted flows.manage caller still sees every run', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFlows(org.orgId)
    const branch = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Flow Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`))
    const flowId = await seedFlow(org.orgId)
    await seedRun(org.orgId, flowId, await makeBill(org.orgId, branch), 'failed')
    await seedRun(org.orgId, flowId, await makeBill(org.orgId, org.subsidiaryId), 'completed')

    await seedUser(org.orgId, 'flow_admin', ['flows.manage'], null)

    const listed = await withOrgContext(org.orgId, () => list())
    const flows = ((await listed.json()) as { flows: Record<string, unknown>[] }).flows
    assert.equal(String(flows[0]!.run_count), '2')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
