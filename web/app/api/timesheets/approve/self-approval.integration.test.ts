import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Separation of duties on the direct approval path: the actor whose person
 * party owns the week cannot approve it while the org's time-approval
 * policy prevents self-approval (the default — an org with no policy row
 * still prevents). Opting out is an explicit policy row; assisting entry
 * ("entered by" a bookkeeper) never counts as authorship.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __selfApprove: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__selfApprove.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: approveWeek } = await import('./route')
const { POST: bulkApprove } = await import('./bulk/route')
const { POST: submitWeek } = await import('../submit/route')
const { PUT } = await import('../route')
const { loadWeek } = await import('../_lib')

const WEEK = '2026-07-12'

async function employeeParty(orgId: string, subsidiaryId: string, name: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${id},${orgId},'employee',${name},${subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${orgId},${id},true)`)
  return id
}

async function fixture() {
  const org = await createScratchOrg()
  const supervisor = await createScratchUser(org.orgId, 'Approver', 'approver')
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: false, timeTracking: true },
    timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  // The approver is also a timekeeper: their login links to their own
  // employee party, exactly like a working supervisor's does.
  const ownParty = await employeeParty(org.orgId, org.subsidiaryId, 'Approver Self')
  await db.execute(sql`update users set party_id=${ownParty} where id=${supervisor} and org_id=${org.orgId}`)
  const coworker = await employeeParty(org.orgId, org.subsidiaryId, 'Crew One')
  const asUser = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${userId.slice(0, 8)}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  asUser(supervisor, 'Approver')
  const save = async (employee: string) => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT',
      body: JSON.stringify({
        employee, week: WEEK,
        rows: [{ projectId: null, itemId: org.items.service, isBillable: false, hours: ['', '', '', '8', '', '', ''] }],
        expectedRevision,
      }),
    })))
  }
  const submit = (employee: string) => withOrgContext(org.orgId, () => submitWeek(new Request('http://time.local/api/timesheets/submit', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const approve = (employee: string) => withOrgContext(org.orgId, () => approveWeek(new Request('http://time.local/api/timesheets/approve', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const bulk = (weeks: { employee: string; week: string }[]) => withOrgContext(org.orgId, () => bulkApprove(new Request('http://time.local/api/timesheets/approve/bulk', {
    method: 'POST', body: JSON.stringify({ weeks }),
  })))
  const entryStatuses = async () => (await db.execute<{ status: string }>(sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${ownParty}`)).rows.map((row) => row.status)
  const allowSelfApproval = () => db.execute(sql`
    insert into time_approval_policies(org_id,effective_from,prevent_self_approval) values (${org.orgId},'2026-01-01',false)`)
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, supervisor, ownParty, coworker, asUser, save, submit, approve, bulk, entryStatuses, allowSelfApproval, close }
}

test('direct approval refuses your own week by default', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.save(f.ownParty)).status, 200)
    assert.equal((await f.submit(f.ownParty)).status, 200)
    const response = await f.approve(f.ownParty)
    assert.equal(response.status, 422, await response.clone().text())
    const body = await response.json() as { error?: string; code?: string; remedy?: string; details?: { setupHref?: string } }
    assert.equal(body.code, 'self_approval_prevented')
    assert.match(body.error ?? '', /your own timesheet/)
    assert.match(body.remedy ?? '', /another approver/i)
    assert.equal(body.details?.setupHref, '/admin/setup/time-approval-policies')
    assert.deepEqual(await f.entryStatuses(), ['submitted'])
  } finally { await f.close() }
})

test('direct approval allows your own week when the policy opts out', async () => {
  const f = await fixture()
  try {
    await f.allowSelfApproval()
    assert.equal((await f.save(f.ownParty)).status, 200)
    assert.equal((await f.submit(f.ownParty)).status, 200)
    const response = await f.approve(f.ownParty)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await f.entryStatuses(), ['approved'])
  } finally { await f.close() }
})

test('direct approval allows a coworker week by default', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.save(f.coworker)).status, 200)
    assert.equal((await f.submit(f.coworker)).status, 200)
    const response = await f.approve(f.coworker)
    assert.equal(response.status, 200, await response.clone().text())
  } finally { await f.close() }
})

test('entering a coworker sheet is not self-approval', async () => {
  const f = await fixture()
  try {
    // The approver enters the coworker's hours (attribution rides the
    // entries) and approves them: assisting entry never matches the
    // employee check, so it stays allowed.
    assert.equal((await f.save(f.coworker)).status, 200)
    assert.equal((await f.submit(f.coworker)).status, 200)
    const enteredBy = (await db.execute<{ by: string | null }>(sql`
      select distinct updated_by as by from time_entries where org_id=${f.org.orgId} and employee_party_id=${f.coworker}`)).rows
    assert.equal(enteredBy[0]?.by, f.supervisor)
    const response = await f.approve(f.coworker)
    assert.equal(response.status, 200, await response.clone().text())
  } finally { await f.close() }
})

test('bulk approval reports per-week self-approval refusals', async () => {
  const f = await fixture()
  try {
    for (const employee of [f.ownParty, f.coworker]) {
      assert.equal((await f.save(employee)).status, 200)
      assert.equal((await f.submit(employee)).status, 200)
    }
    const response = await f.bulk([
      { employee: f.ownParty, week: WEEK },
      { employee: f.coworker, week: WEEK },
    ])
    assert.equal(response.status, 200)
    const body = await response.json() as { results: { employee: string; week: string; ok: boolean; error?: string; code?: string; remedy?: string }[] }
    assert.equal(body.results.length, 2)
    assert.equal(body.results[0]!.ok, false)
    assert.equal(body.results[0]!.code, 'self_approval_prevented')
    assert.ok((body.results[0]!.remedy ?? '').length > 0, 'the refusal carries its remedy')
    assert.equal(body.results[1]!.ok, true)
    assert.deepEqual(await f.entryStatuses(), ['submitted'])
  } finally { await f.close() }
})
