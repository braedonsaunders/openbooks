import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; user: SessionUser | null } = { orgId: '', actorId: '', user: null }
Object.assign(globalThis, { __draftProfileState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual("export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}")
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return virtual('export async function currentUser(){return globalThis.__draftProfileState.user}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__draftProfileState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: postDraft } = await import('../../parties/draft/route')
const { GET: getParty, PATCH: patchParty } = await import('../../parties/[id]/route')
const { GET: getProfiles, POST: postProfile } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * The reported defect: an intermittent 422 saving a valid US payroll profile
 * right after creating the employee. The create path (POST /api/parties/draft)
 * mints an INACTIVE placeholder party with an active role row in one
 * transaction, and the profile save requires parties.is_active — so saving
 * the profile before naming/saving the employee is deterministically refused.
 * The refusal is correct; the defect was that one message covered four
 * distinct causes (no such party, draft party, no active role, no schedule),
 * which made the draft case read as broken data. Each branch below names the
 * predicate that actually failed.
 */
async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Payroll clerk', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    state.user = { id: state.actorId, orgId: org.orgId, name: 'Payroll clerk', email: 'pay@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: state.actorId }
    const scheduleId = randomUUID()
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
              ${state.actorId}, ${state.actorId})`)
    return { org, scheduleId }
  })
}

async function createEmployeeDraft() {
  const response = await withOrgContext(state.orgId, () => postDraft(
    new NextRequest('http://payroll.test/api/parties/draft', { method: 'POST', body: JSON.stringify({ role: 'employee' }) }),
  ))
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as { id: string }
}

async function profileBody(employeePartyId: string, scheduleId: string) {
  const list = (await withOrgContext(state.orgId, () => getProfiles(new Request('http://payroll.test/api'))).then((r) => r.json())) as {
    packProfiles: Record<string, { supportedSubdivisions: string[] }>
  }
  const usState = list.packProfiles['US']!.supportedSubdivisions[0]!
  return { employeePartyId, payScheduleId: scheduleId, country: 'US', province: usState, payBasis: 'hourly', sin: '123-45-6789' }
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () => postProfile(new Request('http://payroll.test/api', { method: 'POST', body: JSON.stringify(body) })))

async function activateParty(id: string, displayName: string) {
  const params = { params: Promise.resolve({ id }) }
  const loaded = await withOrgContext(state.orgId, () => getParty(new Request('http://payroll.test/api'), params as never))
  assert.equal(loaded.status, 200, JSON.stringify(await loaded.clone().json()))
  const token = ((await loaded.json()) as { party: { updated_at: string } }).party.updated_at
  const response = await withOrgContext(state.orgId, () => patchParty(new Request('http://payroll.test/api', {
    method: 'PATCH', body: JSON.stringify({ displayName, expectedUpdatedAt: token }),
  }), params as never))
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
}

test('profile POST on a just-created draft employee names the draft, then saves after activation', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const draft = await createEmployeeDraft()
    const refused = await post(await profileBody(draft.id, scheduleId))
    assert.equal(refused.status, 422, await refused.clone().text())
    assert.match(
      ((await refused.json()) as { error: string }).error,
      /still a draft — save the employee record first/,
    )
    await activateParty(draft.id, 'Draft Sequence Hire')
    const saved = await post(await profileBody(draft.id, scheduleId))
    assert.equal(saved.status, 200, await saved.clone().text())
    const rows = await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*) as count from employee_payroll_profiles
       where org_id = ${org.orgId} and employee_party_id = ${draft.id}`))
    assert.equal(rows.rows[0]!.count, '1')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST distinguishes a missing party from a missing schedule', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const missingParty = await post(await profileBody(randomUUID(), scheduleId))
    assert.equal(missingParty.status, 422, await missingParty.clone().text())
    assert.match(((await missingParty.json()) as { error: string }).error, /employee is not available/)
    const draft = await createEmployeeDraft()
    await activateParty(draft.id, 'Schedule Check Hire')
    const missingSchedule = await post(await profileBody(draft.id, randomUUID()))
    assert.equal(missingSchedule.status, 422, await missingSchedule.clone().text())
    assert.match(((await missingSchedule.json()) as { error: string }).error, /pay schedule is not available/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST names the role when the party is active but its employee role is not', { skip: !DB }, async () => {
  const { org, scheduleId } = await fixture()
  try {
    const draft = await createEmployeeDraft()
    await activateParty(draft.id, 'Role Check Hire')
    await withBypassContext(() => db.execute(sql`
      update employee_roles set is_active = false where org_id = ${org.orgId} and party_id = ${draft.id}`))
    const refused = await post(await profileBody(draft.id, scheduleId))
    assert.equal(refused.status, 422, await refused.clone().text())
    assert.match(((await refused.json()) as { error: string }).error, /employee role is not active/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })
