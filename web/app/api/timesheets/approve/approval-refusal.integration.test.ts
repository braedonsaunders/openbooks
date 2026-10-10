import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Approval refusals are typed, never swallowed. A partner's billable week
 * has no covering wage row, so approval refuses by name — with the
 * employee, the dates, the remedy and the setup link — and rolls the week
 * back to submitted. Allowing unrated time in labor costing setup opens
 * the same approval.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __approvalRefusal: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__approvalRefusal.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: approveWeek } = await import('./route')
const { POST: submitWeek } = await import('../submit/route')
const { PUT } = await import('../route')
const { loadWeek } = await import('../_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const partner = await createScratchUser(org.orgId, 'Partner', 'partner')
  const supervisor = await createScratchUser(org.orgId, 'Time supervisor', 'time_supervisor')
  await db.execute(sql`update app_roles set permissions='["time.self"]'::jsonb where org_id=${org.orgId} and key='partner'`)
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='time_supervisor'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true },
    timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  const mate = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${mate},${org.orgId},'person','Service partner',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`update users set party_id=${mate} where id=${partner} and org_id=${org.orgId}`)
  const as = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${name.replace(/\s/g, '.')}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  const save = async () => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, mate, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT',
      body: JSON.stringify({
        employee: mate, week: WEEK,
        rows: [{ projectId: null, itemId: org.items.service, isBillable: true, hours: ['', '', '6', '', '', '', ''] }],
        expectedRevision,
      }),
    })))
  }
  const submit = () => withOrgContext(org.orgId, () => submitWeek(new Request('http://time.local/api/timesheets/submit', {
    method: 'POST', body: JSON.stringify({ employee: mate, week: WEEK }),
  })))
  const approve = () => withOrgContext(org.orgId, () => approveWeek(new Request('http://time.local/api/timesheets/approve', {
    method: 'POST', body: JSON.stringify({ employee: mate, week: WEEK }),
  })))
  const entries = async () => (await db.execute<{ status: string }>(sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${mate}`)).rows
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, partner, supervisor, mate, as, save, submit, approve, entries, close }
}

test('approval without a covering wage rate refuses by name and rolls back', async () => {
  const f = await fixture()
  try {
    f.as(f.partner, 'Partner')
    assert.equal((await f.save()).status, 200)
    assert.equal((await f.submit()).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    const refused = await f.approve()
    assert.equal(refused.status, 422, await refused.clone().text())
    const body = await refused.json() as { error: string; code: string; remedy: string; details: { uncovered: { employeeName: string | null; workedOn: string }[]; setupHref: string } }
    assert.match(body.error, /no covering cost rate/)
    assert.match(body.error, /Service partner on 2026-07-14/)
    assert.doesNotMatch(body.error, /could not complete its configured financial effects/)
    assert.equal(body.code, 'no_covering_wage_rate')
    assert.match(body.remedy, /Labor costing setup/)
    assert.match(body.remedy, /no employment or compensation record/)
    assert.deepEqual(body.details.uncovered, [{ employeeName: 'Service partner', workedOn: '2026-07-14' }])
    assert.equal(body.details.setupHref, '/admin/setup/labor-costing')
    assert.deepEqual((await f.entries()).map((entry) => entry.status), ['submitted'], 'the refusal rolls back: nothing approved')
  } finally { await f.close() }
})

test('allowing unrated time opens the same approval', async () => {
  const f = await fixture()
  try {
    f.as(f.partner, 'Partner')
    assert.equal((await f.save()).status, 200)
    assert.equal((await f.submit()).status, 200)
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{laborCosting,allowUnratedTime}', 'true'::jsonb, true)
      where id=${f.org.orgId}`)
    f.as(f.supervisor, 'Time supervisor')
    const approved = await f.approve()
    assert.equal(approved.status, 200, await approved.clone().text())
    assert.deepEqual((await f.entries()).map((entry) => entry.status), ['approved'])
  } finally { await f.close() }
})
