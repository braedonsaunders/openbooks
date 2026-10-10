import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

/**
 * Timesheet write scope: who may save a colleague's week.
 *
 * A caller whose role holds time.manage over the whole organization
 * supervises everyone's time by design (the catalogue: time.manage is the
 * supervisory grant), so the save route ACCEPTS a colleague-week save from
 * them — pinTimekeeper and the shared time authority both pass. A caller
 * holding only time.self is confined to the weeks of the person linked to
 * their own login: the same save is refused by name with nothing written.
 * The employee pickers and filters must offer exactly what this rule allows
 * (see the list loader, which filters both by the same predicate).
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __timesheetWriteScope: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__timesheetWriteScope.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PUT } = await import('./route')
const { loadWeek } = await import('./_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  // The QA persona verbatim: a restricted member whose role holds nothing
  // but org-wide time.manage. Beside it, an honest self-only timekeeper.
  const member = await createScratchUser(org.orgId, 'Studio Member', 'studio_member')
  const worker = await createScratchUser(org.orgId, 'Field technician', 'field_technician')
  await db.execute(sql`update app_roles set permissions='["time.manage"]'::jsonb where org_id=${org.orgId} and key='studio_member'`)
  await db.execute(sql`update app_roles set permissions='["time.self","time.clock"]'::jsonb where org_id=${org.orgId} and key='field_technician'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true }, timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  const self = randomUUID(), colleague = randomUUID(), project = randomUUID()
  for (const [id, name] of [[self, 'Own employee'], [colleague, 'Colleague']] as const) {
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${id},${org.orgId},'employee',${name},${org.subsidiaryId},true,'{}'::jsonb)`)
    await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${id},true)`)
  }
  await db.execute(sql`update users set party_id=${self} where id=${worker} and org_id=${org.orgId}`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'SCOPE','Scope job',${org.customerId},'active',true,'{}'::jsonb)`)
  const as = (userId: string, name: string) => {
    session.user = { id: userId, orgId: org.orgId, name, email: `${name.replace(/\s/g, '.')}@example.test`, roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: userId }
  }
  const row = { projectId: project, itemId: org.items.service, isBillable: true, hours: ['', '', '', '4', '', '', ''] }
  const save = async (employee: string) => {
    const expectedRevision = (await withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK))).revision
    return withOrgContext(org.orgId, () => PUT(new Request('http://time.local/api/timesheets', {
      method: 'PUT', body: JSON.stringify({ employee, week: WEEK, rows: [row], expectedRevision }),
    })))
  }
  const entries = async (employee: string) => (await db.execute<{ status: string }>(sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${employee}`)).rows
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, member, worker, self, colleague, as, save, entries, close }
}

test('a time.manage holder saves a colleague week: the server accepts by design', async () => {
  const f = await fixture()
  try {
    f.as(f.member, 'Studio Member')
    const saved = await f.save(f.colleague)
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.deepEqual((await f.entries(f.colleague)).map((entry) => entry.status), ['draft'])
  } finally { await f.close() }
})

test('a self-only holder saving a colleague week is refused by name with nothing written', async () => {
  const f = await fixture()
  try {
    f.as(f.worker, 'Field technician')
    const refused = await f.save(f.colleague)
    assert.equal(refused.status, 403)
    const body = await refused.json() as { code?: string; error?: string; remedy?: string }
    assert.equal(body.code, 'time_self_only')
    assert.ok(body.remedy, 'the refusal names its remedy')
    assert.deepEqual(await f.entries(f.colleague), [], 'the colleague week is untouched')
  } finally { await f.close() }
})

test('a self-only holder still saves their own week', async () => {
  const f = await fixture()
  try {
    f.as(f.worker, 'Field technician')
    const saved = await f.save(f.self)
    assert.equal(saved.status, 200, await saved.clone().text())
    assert.deepEqual((await f.entries(f.self)).map((entry) => entry.status), ['draft'])
  } finally { await f.close() }
})
