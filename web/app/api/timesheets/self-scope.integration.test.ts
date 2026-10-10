import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

/**
 * Self-service time (time.self) confines an employee to the weeks of the
 * employee linked to their own login, at the API — not only on the page.
 * A coworker's week is refused by name for read, save and submit, with no
 * write; a supervisor holding time.read/time.manage is unaffected.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __timesheetSelfScope: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__timesheetSelfScope.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PUT } = await import('./route')
const { POST: submitWeek } = await import('./submit/route')
const { loadWeek } = await import('./_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const worker = await createScratchUser(org.orgId, 'Field technician', 'field_technician')
  const supervisor = await createScratchUser(org.orgId, 'Time supervisor', 'time_supervisor')
  await db.execute(sql`update app_roles set permissions='["time.self","time.clock"]'::jsonb where org_id=${org.orgId} and key='field_technician'`)
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","projects.read"]'::jsonb where org_id=${org.orgId} and key='time_supervisor'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true }, timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  const own = randomUUID(), coworker = randomUUID(), project = randomUUID()
  for (const [id, name] of [[own, 'Own employee'], [coworker, 'Coworker']] as const) {
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${id},${org.orgId},'employee',${name},${org.subsidiaryId},true,'{}'::jsonb)`)
    await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${id},true)`)
  }
  await db.execute(sql`update users set party_id=${own} where id=${worker} and org_id=${org.orgId}`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'SELF','Self scope',${org.customerId},'active',true,'{}'::jsonb)`)
  const as = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${name.replace(/\s/g, '.')}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  const row = { projectId: project, itemId: org.items.service, isBillable: true, hours: ['', '', '', '4', '', '', ''] }
  const read = (employee: string) => withOrgContext(org.orgId, () =>
    GET(new Request(`http://time.local/api/timesheets?employee=${employee}&week=${WEEK}`)))
  const save = async (employee: string) => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT', body: JSON.stringify({ employee, week: WEEK, rows: [row], expectedRevision }),
    })))
  }
  const submit = (employee: string) => withOrgContext(org.orgId, () => submitWeek(new Request('http://time.local/api/timesheets/submit', {
    method: 'POST', body: JSON.stringify({ employee, week: WEEK }),
  })))
  const entries = async (employee: string) => (await db.execute<{ status: string }>(sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${employee}`)).rows
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, worker, supervisor, own, coworker, as, read, save, submit, entries, close }
}

test('a self-service time user reads, enters and submits only their own week', async () => {
  const f = await fixture()
  try {
    f.as(f.worker, 'Field technician')
    assert.equal((await f.read(f.own)).status, 200, 'their own week opens')
    const saved = await f.save(f.own)
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.equal((await f.entries(f.own)).length, 1)
    const submitted = await f.submit(f.own)
    assert.equal(submitted.status, 200, await submitted.clone().text())
    assert.deepEqual((await f.entries(f.own)).map((entry) => entry.status), ['submitted'])
  } finally { await f.close() }
})

test("a coworker's week is refused by name for read, save and submit, with nothing written", async () => {
  const f = await fixture()
  try {
    f.as(f.supervisor, 'Time supervisor')
    assert.equal((await f.save(f.coworker)).status, 200, 'the supervisor seeds the coworker week')
    const before = await f.entries(f.coworker)

    f.as(f.worker, 'Field technician')
    for (const response of [await f.read(f.coworker), await f.save(f.coworker), await f.submit(f.coworker)]) {
      assert.equal(response.status, 403)
      const body = await response.json() as { code?: string; error?: string; remedy?: string }
      assert.equal(body.code, 'time_self_only')
      assert.ok(body.remedy, 'the refusal names its remedy')
    }
    assert.deepEqual(await f.entries(f.coworker), before, 'the coworker week is untouched')
  } finally { await f.close() }
})

test('a supervisor holding time.read and time.manage keeps working on anyone\'s week', async () => {
  const f = await fixture()
  try {
    f.as(f.supervisor, 'Time supervisor')
    for (const employee of [f.own, f.coworker]) {
      assert.equal((await f.read(employee)).status, 200)
      assert.equal((await f.save(employee)).status, 200)
      assert.equal((await f.submit(employee)).status, 200)
    }
  } finally { await f.close() }
})
