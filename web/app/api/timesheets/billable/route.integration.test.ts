import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { env } from '@openbooks/engine/src/platform/db.ts'
import type { SessionUser } from '../../../../lib/auth'

/**
 * An approver marks submitted review-grid lines billable or not (a write-off)
 * before approval, through the native time-entry update path:
 * - only submitted entries flip; every flip is audited per entry with
 *   before/after, and the approval that follows snapshots bill rates off the
 *   final flag;
 * - approved lines refuse by name (reopen/amend is the way back) and billed
 *   lines refuse by name (credit memo on the invoice, never a rewrite).
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __timesheetBillable: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__timesheetBillable.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: setBillable } = await import('./route')
const { POST: submitWeek } = await import('../submit/route')
const { POST: approveWeek } = await import('../approve/route')
const { PUT } = await import('../route')
const { loadWeek } = await import('../_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const mate = await createScratchUser(org.orgId, 'Billable Mate', 'mate')
  const supervisor = await createScratchUser(org.orgId, 'Time supervisor', 'time_supervisor')
  await db.execute(sql`update app_roles set permissions='["time.self"]'::jsonb where org_id=${org.orgId} and key='mate'`)
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='time_supervisor'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true },
    timesheets: { requireApproval: true },
    laborCosting: { allowUnratedTime: true },
  })}::jsonb where id=${org.orgId}`)
  const projectId = randomUUID()
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-BILLABLE', 'Billable job', ${org.customerId}, 'active', true, '{}'::jsonb)
  `)
  const as = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${name.replace(/\s/g, '.')}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  const line = { projectId, itemId: org.items.service, timeTypeId: null, departmentId: null, memo: null, custom: {} }
  const save = async () => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, mate, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT',
      body: JSON.stringify({
        employee: mate, week: WEEK, expectedRevision,
        rows: [{ ...line, isBillable: true, hours: ['', '', '6', '', '', '', ''] }],
      }),
    })))
  }
  const submit = () => withOrgContext(org.orgId, () => submitWeek(new Request('http://time.local/api/timesheets/submit', {
    method: 'POST', body: JSON.stringify({ employee: mate, week: WEEK }),
  })))
  const billable = (isBillable: boolean) => withOrgContext(org.orgId, () => setBillable(new Request('http://time.local/api/timesheets/billable', {
    method: 'POST', body: JSON.stringify({ employee: mate, week: WEEK, line, isBillable }),
  })))
  const approve = () => withOrgContext(org.orgId, () => approveWeek(new Request('http://time.local/api/timesheets/approve', {
    method: 'POST', body: JSON.stringify({ employee: mate, week: WEEK }),
  })))
  const entries = async () => (await db.execute<{ status: string; is_billable: boolean; billing_status: string }>(sql`
    select status, is_billable, billing_status from time_entries where org_id=${org.orgId} and employee_party_id=${mate}`)).rows
  const close = async () => { session.user = null; await dropScratchOrg(org.orgId) }
  return { org, mate, supervisor, projectId, line, as, save, submit, billable, approve, entries, close }
}

const needsDb = { skip: !env.OPENBOOKS_DB_URL }

test('an approver marks a submitted line non-billable with per-entry audit, and approval keeps the final flag', needsDb, async () => {
  const f = await fixture()
  try {
    f.as(f.mate, 'Billable Mate')
    assert.equal((await f.save()).status, 200)
    assert.equal((await f.submit()).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    const edited = await f.billable(false)
    assert.equal(edited.status, 200, await edited.clone().text())
    assert.deepEqual((await f.entries()).map((entry) => entry.is_billable), [false])
    const audit = await db.execute<{ action: string; actor_id: string; changes: unknown }>(sql`
      select action, actor_id, changes from audit_log
       where org_id=${f.org.orgId} and table_name='time_entries'
    `)
    assert.equal(audit.rows.length, 1, 'the flag change leaves exactly one audit row for the entry')
    assert.equal(audit.rows[0].action, 'update')
    assert.equal(audit.rows[0].actor_id, f.supervisor, 'the audit names the approver, not the timekeeper')
    const changes = audit.rows[0].changes as { event: string; before: { is_billable: boolean }; after: { is_billable: boolean } }
    assert.equal(changes.event, 'billable_changed')
    assert.deepEqual([changes.before.is_billable, changes.after.is_billable], [true, false])
    const approved = await f.approve()
    assert.equal(approved.status, 200, await approved.clone().text())
    const after = await f.entries()
    assert.deepEqual(after.map((entry) => entry.status), ['approved'])
    assert.deepEqual(after.map((entry) => entry.is_billable), [false], 'approval snapshots the final flag, not the entered one')
  } finally { await f.close() }
})

test('a billable change on an approved line refuses by name with the way back', needsDb, async () => {
  const f = await fixture()
  try {
    f.as(f.mate, 'Billable Mate')
    assert.equal((await f.save()).status, 200)
    assert.equal((await f.submit()).status, 200)
    f.as(f.supervisor, 'Time supervisor')
    assert.equal((await f.approve()).status, 200)
    const refused = await f.billable(false)
    assert.equal(refused.status, 409, await refused.clone().text())
    const body = await refused.json() as { error: string; code: string; remedy: string }
    assert.equal(body.code, 'line_approved')
    assert.match(body.error, /already approved/)
    assert.match(body.remedy, /Reopen or amend/)
    assert.deepEqual((await f.entries()).map((entry) => entry.is_billable), [true], 'the refusal flips nothing')
  } finally { await f.close() }
})

test('a billable change on a billed line refuses by name with the invoice remedy', needsDb, async () => {
  const f = await fixture()
  try {
    f.as(f.mate, 'Billable Mate')
    assert.equal((await f.save()).status, 200)
    assert.equal((await f.submit()).status, 200)
    await db.execute(sql`update time_entries set billing_status='billed' where org_id=${f.org.orgId} and employee_party_id=${f.mate}`)
    f.as(f.supervisor, 'Time supervisor')
    const refused = await f.billable(false)
    assert.equal(refused.status, 409, await refused.clone().text())
    const body = await refused.json() as { error: string; code: string; remedy: string }
    assert.equal(body.code, 'line_billed')
    assert.match(body.error, /already billed/)
    assert.match(body.remedy, /credit memo/)
    assert.deepEqual((await f.entries()).map((entry) => entry.is_billable), [true], 'the refusal flips nothing')
  } finally { await f.close() }
})
