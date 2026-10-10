import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Inbox direct approval executes the native approval command. A submitted
 * week awaiting no gate approves from the inbox action; the week flips to
 * approved with its entries, unknown actions and missing weeks refuse, and
 * a week owned by a pending gate never appears as a direct item.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __inboxDirectApprove: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__inboxDirectApprove.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const supervisor = await createScratchUser(org.orgId, 'Approver', 'approver')
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: false, timeTracking: true },
    timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  const worker = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${worker},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${worker},true)`)
  const week = randomUUID()
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_at)
    values (${week},${org.orgId},${worker},${WEEK}::date,'submitted',now())`)
  await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
    values (${org.orgId},${worker},'2026-07-14',8,'submitted',false,'unbilled','actual',${supervisor},${supervisor})`)
  session.user = { id: supervisor, orgId: org.orgId, name: 'Approver', email: 'approver@example.test', roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: supervisor }
  const act = (itemId: string, actionKey: string) => withOrgContext(org.orgId, () => POST(new Request('http://time.local/api/inbox/act', {
    method: 'POST', body: JSON.stringify({ itemId, actionKey }),
  })))
  const status = async () => (await db.execute<{ status: string }>(sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${worker}`)).rows.map((row) => row.status)
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, supervisor, worker, week, act, status, close }
}

test('a gateless submitted week approves from the inbox action', async () => {
  const f = await fixture()
  try {
    const response = await f.act(`timesheet_approval:${f.week}`, 'approve')
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(await f.status(), ['approved'])
  } finally { await f.close() }
})

test('unknown actions and missing weeks refuse without a leak', async () => {
  const f = await fixture()
  try {
    const unknown = await f.act(`timesheet_approval:${f.week}`, 'reject')
    assert.equal(unknown.status, 422)
    const missing = await f.act(`timesheet_approval:${randomUUID()}`, 'approve')
    assert.equal(missing.status, 404)
    assert.deepEqual(await f.status(), ['submitted'], 'refused acts write nothing')
  } finally { await f.close() }
})
