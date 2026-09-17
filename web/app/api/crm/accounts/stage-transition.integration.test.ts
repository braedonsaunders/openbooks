import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t02-001: moving a lead to Prospect from the account drawer must persist.
// The drawer sends the whole form, including the now-stale lead status id,
// alongside the new stage. The stage write must survive that payload (and a
// missing status), while genuinely unknown statuses still fail closed.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmStageTransitionState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier.endsWith('/lib/authz')) return virtual(`
      export async function guardPermission() {
        const s = globalThis.__crmStageTransitionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.endsWith('/lib/feature-gates')) return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmStageTransitionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm.ts')
const { PATCH } = await import('./[id]/route.ts')
const { POST: postDraft } = await import('./draft/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

type Fixture = { orgId: string; partyId: string; leadStatusId: string; prospectDefaultId: string; prospectOtherId: string }

async function fixture(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  state.actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = settings || '{"features": {"crm": true}}'::jsonb where id = ${org.orgId}`)
    await ensureCrmDefaults(org.orgId, state.actorId)
  })
  const statuses = (await withBypassContext(() => db.execute<{ id: string; key: string; lifecycle_stage: string; is_default: boolean }>(sql`
    select id, key, lifecycle_stage, is_default from crm_account_statuses where org_id = ${org.orgId} and is_active`))).rows
  const leadStatusId = statuses.find((s) => s.lifecycle_stage === 'lead' && s.is_default)!.id
  const prospectDefaultId = statuses.find((s) => s.lifecycle_stage === 'prospect' && s.is_default)!.id
  const prospectOtherId = statuses.find((s) => s.lifecycle_stage === 'prospect' && !s.is_default)!.id
  const partyId = await withBypassContext(async () => {
    const pid = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, is_active)
      values (${org.orgId}, 'company', 'Stagelead', true) returning id`)).rows[0]!.id
    await db.execute(sql`
      insert into crm_account_profiles (org_id, party_id, lifecycle_stage, status_id, is_active)
      values (${org.orgId}, ${pid}, 'lead', ${leadStatusId}, true)`)
    return pid
  })
  return { orgId: org.orgId, partyId, leadStatusId, prospectDefaultId, prospectOtherId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: { error?: string } | null }> {
  const response = await withOrgContext(state.orgId, () => PATCH(
    new Request(`http://crm.test/api/crm/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ))
  return { status: response.status, json: (await response.json().catch(() => null)) as { error?: string } | null }
}

async function draft(body: unknown): Promise<{ status: number; json: { id?: string; error?: string } | null }> {
  const response = await withOrgContext(state.orgId, () => postDraft(
    new Request('http://crm.test/api/crm/accounts/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ))
  return { status: response.status, json: (await response.json().catch(() => null)) as { id?: string; error?: string } | null }
}

async function profile(partyId: string) {
  return (await withBypassContext(() => db.execute<{ lifecycle_stage: string; status_id: string | null; status_key: string | null }>(sql`
    select cp.lifecycle_stage, cp.status_id, s.key as status_key
      from crm_account_profiles cp left join crm_account_statuses s on s.id = cp.status_id
     where cp.party_id = ${partyId}`))).rows[0]!
}

async function stageEvents(partyId: string) {
  return (await withBypassContext(() => db.execute<{ from_stage: string | null; to_stage: string; source_kind: string }>(sql`
    select e.from_stage, e.to_stage, e.source_kind from crm_account_stage_events e
     join crm_account_profiles cp on cp.id = e.account_profile_id
     where cp.party_id = ${partyId} order by e.occurred_at`))).rows
}

test('PATCH keeps a stage-only drawer save: stale lead status falls back to the prospect default', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    // Byte-shape of the AccountDrawer save when only the stage dropdown moved.
    const result = await patch(f.partyId, {
      displayName: 'Stagelead', email: '', phone: '', website: '',
      lifecycleStage: 'prospect', statusId: f.leadStatusId,
      ownerUserId: null, territoryId: null, leadSourceId: null,
      industry: '', category: '', annualRevenue: '', employeeCount: '',
      qualificationScore: '', nextActionAt: null, isActive: true,
    })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.deepEqual(await profile(f.partyId), { lifecycle_stage: 'prospect', status_id: f.prospectDefaultId, status_key: 'open' })
    assert.deepEqual(await stageEvents(f.partyId), [{ from_stage: 'lead', to_stage: 'prospect', source_kind: 'manual' }])
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('PATCH honors an explicit new-stage status on promotion', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await patch(f.partyId, { lifecycleStage: 'prospect', statusId: f.prospectOtherId })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const row = await profile(f.partyId)
    assert.equal(row.lifecycle_stage, 'prospect')
    assert.equal(row.status_id, f.prospectOtherId)
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('PATCH with a cleared status on promotion keeps the promoted default instead of nulling it', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await patch(f.partyId, { lifecycleStage: 'prospect', statusId: null })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.deepEqual(await profile(f.partyId), { lifecycle_stage: 'prospect', status_id: f.prospectDefaultId, status_key: 'open' })
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('PATCH with an unknown status id still fails closed on a stage change', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await patch(f.partyId, { lifecycleStage: 'prospect', statusId: randomUUID() })
    assert.equal(result.status, 422, JSON.stringify(result.json))
    assert.equal((await profile(f.partyId)).lifecycle_stage, 'lead')
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('PATCH without a stage change still rejects a status from another stage', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await patch(f.partyId, { statusId: f.prospectDefaultId })
    assert.equal(result.status, 422, JSON.stringify(result.json))
    assert.equal((await profile(f.partyId)).status_id, f.leadStatusId)
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('draft with a prospect stage creates a prospect with the prospect default status', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await draft({ lifecycleStage: 'prospect' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const createdId = result.json!.id!
    assert.deepEqual(await profile(createdId), { lifecycle_stage: 'prospect', status_id: f.prospectDefaultId, status_key: 'open' })
    assert.deepEqual(await stageEvents(createdId), [{ from_stage: null, to_stage: 'prospect', source_kind: 'manual' }])
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('draft without a stage still creates a lead', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const result = await draft({})
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal((await profile(result.json!.id!)).lifecycle_stage, 'lead')
  } finally {
    await dropScratchOrg(f.orgId)
  }
})

test('draft refuses an uncreatable stage instead of silently creating a lead', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    for (const lifecycleStage of ['customer', ' closed ', 42, null]) {
      const result = await draft({ lifecycleStage })
      assert.equal(result.status, 422, `${JSON.stringify(lifecycleStage)}: ${JSON.stringify(result.json)}`)
    }
  } finally {
    await dropScratchOrg(f.orgId)
  }
})
