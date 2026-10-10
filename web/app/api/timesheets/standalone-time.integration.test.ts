import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

/**
 * Standalone time tracking: hourly time and attendance need no job costing,
 * and partners log billable time as people rather than employees.
 *
 * - With Projects off and Time Tracking on, weekly timesheets open, save
 *   and approve for lines that name no project; a line naming a project
 *   refuses with the Projects remedy and writes nothing.
 * - Clock-in works with Projects off through the field-time switch.
 * - A person party with no employment (a partner) records billable time
 *   against the login's own link; payroll admits only employments, so the
 *   partner's approved hours stay unclaimed (proven in
 *   engine/src/payroll/timekeeper-exclusion.integration.test.ts).
 * - time.self still confines a caller to their own linked person.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __standaloneTime: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__standaloneTime.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { fieldClockOwnerKey } = await import('../../../lib/field-clock-owner')
const { GET, PUT } = await import('./route')
const { POST: submitWeek } = await import('./submit/route')
const { POST: approveWeek } = await import('./approve/route')
const { POST: rejectWeek } = await import('./reject/route')
const { POST: reopenWeek } = await import('./reopen/route')
const { POST: amendWeek } = await import('./amend/route')
const { POST: clockIn } = await import('../time/clock/route')
const { loadWeek } = await import('./_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const barista = await createScratchUser(org.orgId, 'Barista', 'barista')
  const partner = await createScratchUser(org.orgId, 'Partner', 'partner')
  const supervisor = await createScratchUser(org.orgId, 'Time supervisor', 'time_supervisor')
  await db.execute(sql`update app_roles set permissions='["time.self","time.clock"]'::jsonb where org_id=${org.orgId} and key='barista'`)
  await db.execute(sql`update app_roles set permissions='["time.self"]'::jsonb where org_id=${org.orgId} and key='partner'`)
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve","time.reopen"]'::jsonb where org_id=${org.orgId} and key='time_supervisor'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: false, timeTracking: true, fieldTime: true },
    timesheets: { requireApproval: true },
    fieldTime: { roundingIncrement: 0, roundingMode: 'nearest', unpaidBreakMinutes: 0, autoCloseHours: 12, signatureRequired: false },
  })}::jsonb where id=${org.orgId}`)
  const own = randomUUID(), mate = randomUUID(), project = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${own},${org.orgId},'employee','Own barista',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${own},true)`)
  // A partner: a person with no employment row anywhere.
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${mate},${org.orgId},'person','Service partner',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`update users set party_id=${own} where id=${barista} and org_id=${org.orgId}`)
  await db.execute(sql`update users set party_id=${mate} where id=${partner} and org_id=${org.orgId}`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'ROAST','Roastery build',${org.customerId},'active',true,'{}'::jsonb)`)
  const as = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${name.replace(/\s/g, '.')}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  const plainRow = { projectId: null, itemId: org.items.service, isBillable: false, hours: ['', '', '', '8', '', '', ''] }
  const read = (employee: string) => withOrgContext(org.orgId, () =>
    GET(new Request(`http://time.local/api/timesheets?employee=${employee}&week=${WEEK}`)))
  const save = async (employee: string, rows = [plainRow]) => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT', body: JSON.stringify({ employee, week: WEEK, rows, expectedRevision }),
    })))
  }
  const submit = (employee: string) => withOrgContext(org.orgId, () => submitWeek(new Request('http://time.local/api/timesheets/submit', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const approve = (employee: string) => withOrgContext(org.orgId, () => approveWeek(new Request('http://time.local/api/timesheets/approve', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const reject = (employee: string) => withOrgContext(org.orgId, () => rejectWeek(new Request('http://time.local/api/timesheets/reject', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK, reason: 'Correct Tuesday hours' }),
  })))
  const reopen = (employee: string) => withOrgContext(org.orgId, () => reopenWeek(new Request('http://time.local/api/timesheets/reopen', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const amend = (employee: string) => withOrgContext(org.orgId, () => amendWeek(new Request('http://time.local/api/timesheets/amend', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const clock = (userId: string, partyId: string) => withOrgContext(org.orgId, () => clockIn(new Request('http://time.local/api/time/clock', {
    method: 'POST',
    body: JSON.stringify({
      ownerKey: fieldClockOwnerKey(org.orgId, userId, partyId),
      kind: 'clock_in', occurredAt: new Date().toISOString(), clientEventId: randomUUID(),
    }),
  })))
  const entries = async (employee: string) => (await db.execute<{ status: string; is_billable: boolean }>(sql`
    select status, is_billable from time_entries where org_id=${org.orgId} and employee_party_id=${employee}`)).rows
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, barista, partner, supervisor, own, mate, project, as, read, save, submit, approve, reject, reopen, amend, clock, entries, close }
}

test('timesheets, clock and approval work with Projects off', async () => {
  const f = await fixture()
  try {
    f.as(f.barista, 'Barista')
    assert.equal((await f.read(f.own)).status, 200, 'their own week opens with Projects off')
    const saved = await f.save(f.own)
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.equal((await f.entries(f.own)).length, 1)
    assert.equal((await f.clock(f.barista, f.own)).status, 200, 'clock-in works with Projects off')
    const submitted = await f.submit(f.own)
    assert.equal(submitted.status, 200, await submitted.clone().text())
    f.as(f.supervisor, 'Time supervisor')
    const approved = await f.approve(f.own)
    assert.equal(approved.status, 200, await approved.clone().text())
    assert.deepEqual((await f.entries(f.own)).map((entry) => entry.status), ['approved'])
  } finally { await f.close() }
})

test('reject, reopen and amend run the full lifecycle with Projects off', async () => {
  const f = await fixture()
  try {
    f.as(f.barista, 'Barista')
    assert.equal((await f.save(f.own)).status, 200)
    assert.equal((await f.submit(f.own)).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    const rejected = await f.reject(f.own)
    assert.equal(rejected.status, 200, await rejected.clone().text())
    assert.deepEqual((await f.entries(f.own)).map((entry) => entry.status), ['rejected'])
    f.as(f.barista, 'Barista')
    assert.equal((await f.save(f.own)).status, 200, 'rejected entries stay editable')
    assert.equal((await f.submit(f.own)).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    assert.equal((await f.approve(f.own)).status, 200)
    const reopened = await f.reopen(f.own)
    assert.equal(reopened.status, 200, await reopened.clone().text())
    assert.deepEqual((await f.entries(f.own)).map((entry) => entry.status), ['draft'])
    f.as(f.barista, 'Barista')
    assert.equal((await f.submit(f.own)).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    assert.equal((await f.approve(f.own)).status, 200)
    const amended = await f.amend(f.own)
    assert.equal(amended.status, 201, await amended.clone().text())
    assert.equal((await amended.json() as { amended?: number }).amended, 0, 'nothing consumed, no offsets')
  } finally { await f.close() }
})

test('a line naming a project refuses while Projects is off and writes nothing', async () => {
  const f = await fixture()
  try {
    f.as(f.barista, 'Barista')
    const before = await f.entries(f.own)
    const refused = await f.save(f.own, [{ projectId: f.project, itemId: f.org.items.service, isBillable: true, hours: ['', '', '', '4', '', '', ''] }])
    assert.equal(refused.status, 422)
    assert.match(((await refused.json()) as { error: string }).error, /Projects feature is disabled/)
    assert.deepEqual(await f.entries(f.own), before, 'the refused save writes nothing')
  } finally { await f.close() }
})

test('a partner without employment records billable time but never a coworker week', async () => {
  const f = await fixture()
  try {
    f.as(f.partner, 'Partner')
    assert.equal((await f.read(f.mate)).status, 200, 'their own week opens without employment')
    const saved = await f.save(f.mate, [{ projectId: null, itemId: f.org.items.service, isBillable: true, hours: ['', '', '6', '', '', '', ''] }])
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.deepEqual((await f.entries(f.mate)).map((entry) => entry.is_billable), [true])
    assert.equal((await f.read(f.own)).status, 403, 'a coworker week stays refused under time.self')
    const submitted = await f.submit(f.mate)
    assert.equal(submitted.status, 200, await submitted.clone().text())
    f.as(f.supervisor, 'Time supervisor')
    // Costing is a Projects-module policy: with Projects off there is no
    // wage evidence to require, so partner hours approve like anyone's.
    // (With Projects on, the same approval refuses by name unless the org
    // allows unrated time — see approval-refusal.integration.test.ts.)
    const approved = await f.approve(f.mate)
    assert.equal(approved.status, 200, await approved.clone().text())
    assert.deepEqual((await f.entries(f.mate)).map((entry) => entry.status), ['approved'])
  } finally { await f.close() }
})
