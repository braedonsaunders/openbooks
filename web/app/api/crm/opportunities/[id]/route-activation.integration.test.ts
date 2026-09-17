import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t03-014 residual: SIM OPP-00002 (titled, Closed-lost, no account, no
// subsidiary) was invisible under Status=All with every facet at 0 while its
// drawer saved 200s. Read-only diagnosis on the cluster proved subsidiary
// scoping innocent — the SIM tester resolves to an unscoped (null) allowed
// set and the real opportunityWhere lists both SIM rows once is_active is
// lifted — so the sole killer was the stale is_active=false the rows carried
// from pre-activation-fix saves (plus a re-verify that re-loaded but never
// re-saved). This pins the exact SIM shape end to end: a drawer-shaped PATCH
// (no isActive flag) closing an account-less, subsidiary-less titled
// opportunity activates it into the Status=All list, while a
// placeholder-titled stub stays hidden. Fails on pre-49f9046cd code, which
// required an account for every activation.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __opportunityActivationState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__opportunityActivationState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__opportunityActivationState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { opportunityWhere, OPPORTUNITY_BASE_JOINS } = await import(
  '../../../../../lib/customization/entity-list-query/opportunities.ts'
)
const { PATCH } = await import('./route.ts')
const { defaultListView } = await import('@openbooks/customization')
const { installTrustedTestDatabaseBypass } = await import(root + 'engine/src/test-database-bypass.ts')
// The route chain pulls in web/lib/request-org, which claims the
// process-global request-org resolver slot at import time and displaces the
// trusted test bypass installed by the --import preload. Re-install last so
// scratch seeding keeps its authority.
installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`)
  const statuses = (await db.execute<{ id: string; key: string }>(sql`
    insert into crm_opportunity_statuses (org_id, key, name, probability, is_closed, is_won, is_active)
    values (${org.orgId}, 'open', 'Open', 10, false, false, true),
           (${org.orgId}, 'closed_lost', 'Closed lost', 0, true, false, true)
    returning id, key`)).rows
  const openId = statuses.find((s) => s.key === 'open')!.id
  const closedLostId = statuses.find((s) => s.key === 'closed_lost')!.id
  return { org, openId, closedLostId }
}

async function seedOpp(orgId: string, number: string, title: string, statusId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into crm_opportunities (org_id, opportunity_number, title, status_id, currency, is_active)
    values (${orgId}, ${number}, ${title}, ${statusId}, 'CAD', false)
    returning id`)).rows[0]!.id
}

async function revision(id: string): Promise<string> {
  const row = (await db.execute<{ revision: string }>(sql`
    select (revision_seq)::text as revision
      from crm_opportunities where id = ${id}`)).rows[0]!
  return row.revision
}

async function patch(id: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  try {
    const expectedUpdatedAt = await revision(id)
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://crm.test/api/crm/opportunities/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, expectedUpdatedAt }),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function listedNumbers(orgId: string): Promise<string[]> {
  const where = opportunityWhere(
    { ...defaultListView('opportunity'), filters: [] },
    { showInactive: false, filters: {}, q: '' } as never,
    orgId,
    null,
  )
  const rows = (await withOrgContext(orgId, () => db.execute<{ opportunity_number: string }>(sql`
    select o.opportunity_number from crm_opportunities o ${OPPORTUNITY_BASE_JOINS} where ${where}`))).rows
  return rows.map((r) => r.opportunity_number)
}

test('closing an account-less titled opportunity activates it into the Status=All list', { skip: !DB }, async () => {
  const { org, openId, closedLostId } = await fixture()
  try {
    // The exact SIM OPP-00002 shape: real title, no account, no subsidiary,
    // carried inactive from its creation-stub save.
    const oppId = await seedOpp(org.orgId, 'OPP-SIM-2', 'SIM Verify Opp', openId)
    assert.deepEqual(await listedNumbers(org.orgId), [], 'stale inactive row hides like the SIM list')

    // Drawer-shaped close: status + loss reason, no isActive flag.
    const saved = await patch(oppId, { statusId: closedLostId, winLossReason: 'Lost on price' })
    assert.equal(saved.status, 200)
    const active = (await db.execute<{ is_active: boolean }>(sql`
      select is_active from crm_opportunities where id = ${oppId}`)).rows[0]!.is_active
    assert.equal(active, true, 'titled closed record activates without an account')
    assert.deepEqual(await listedNumbers(org.orgId), ['OPP-SIM-2'], 'activated record lists under Status=All')
  } finally {
    state.orgId = ''
    state.actorId = ''
    await dropScratchOrg(org.orgId)
  }
})

test('a placeholder-titled stub stays hidden after an open save', { skip: !DB }, async () => {
  const { org, openId } = await fixture()
  try {
    const oppId = await seedOpp(org.orgId, 'OPP-SIM-1', 'New opportunity', openId)
    const saved = await patch(oppId, { statusId: openId })
    assert.equal(saved.status, 200)
    const active = (await db.execute<{ is_active: boolean }>(sql`
      select is_active from crm_opportunities where id = ${oppId}`)).rows[0]!.is_active
    assert.equal(active, false, 'untitled stub must not leak into the list')
    assert.deepEqual(await listedNumbers(org.orgId), [])
  } finally {
    state.orgId = ''
    state.actorId = ''
    await dropScratchOrg(org.orgId)
  }
})
