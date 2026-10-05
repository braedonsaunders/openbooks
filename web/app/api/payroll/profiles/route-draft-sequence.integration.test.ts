import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { SessionUser } from '../../../../lib/auth'

const state: { orgId: string; actorId: string; user: SessionUser | null } = { orgId: '', actorId: '', user: null }
Object.assign(globalThis, { __draftProfileState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return virtual("export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}")
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return virtual('export async function currentUser(){return globalThis.__draftProfileState.user}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__draftProfileState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: postParty } = await import('../../parties/route')
const { GET: getParty, PATCH: patchParty } = await import('../../parties/[id]/route')
const { GET: getProfiles, POST: postProfile } = await import('./route')

/**
 * Payroll profiles require a saved employee role. Create a named employee
 * through the canonical party endpoint, then verify missing-party, missing-
 * schedule, and inactive-role refusals remain distinguishable.
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

async function createEmployee() {
  const response = await withOrgContext(state.orgId, () => postParty(
    new NextRequest('http://payroll.test/api/parties', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ kind: 'employee', displayName: 'New Payroll Employee', roles: { employee: { enabled: true } } }),
    }),
  ))
  assert.equal(response.status, 201, await response.clone().text())
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

test('profile POST distinguishes a missing party from a missing schedule', async () => {
  const { org, scheduleId } = await fixture()
  try {
    const missingParty = await post(await profileBody(randomUUID(), scheduleId))
    assert.equal(missingParty.status, 422, await missingParty.clone().text())
    assert.match(((await missingParty.json()) as { error: string }).error, /employee is not available/)
    const employee = await createEmployee()
    await activateParty(employee.id, 'Schedule Check Hire')
    const missingSchedule = await post(await profileBody(employee.id, randomUUID()))
    assert.equal(missingSchedule.status, 422, await missingSchedule.clone().text())
    assert.match(((await missingSchedule.json()) as { error: string }).error, /pay schedule is not available/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('profile POST names the role when the party is active but its employee role is not', async () => {
  const { org, scheduleId } = await fixture()
  try {
    const employee = await createEmployee()
    await activateParty(employee.id, 'Role Check Hire')
    await withBypassContext(() => db.execute(sql`
      update employee_roles set is_active = false where org_id = ${org.orgId} and party_id = ${employee.id}`))
    const refused = await post(await profileBody(employee.id, scheduleId))
    assert.equal(refused.status, 422, await refused.clone().text())
    assert.match(((await refused.json()) as { error: string }).error, /employee role has ended — .*Save to restore the employee role/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test.after(async () => { await pool.end() })

test('profile POST names reactivation when the employee has been deactivated', async () => {
  const { org, scheduleId } = await fixture()
  try {
    const employee = await createEmployee()
    await activateParty(employee.id, 'Former Hire')
    await withBypassContext(() => db.execute(sql`
      update parties set is_active = false where org_id = ${org.orgId} and id = ${employee.id}`))
    const refused = await post(await profileBody(employee.id, scheduleId))
    assert.equal(refused.status, 422, await refused.clone().text())
    const message = ((await refused.json()) as { error: string }).error
    assert.match(message, /employee is inactive — reactivate them from Employees/)
    assert.doesNotMatch(message, /draft/)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
