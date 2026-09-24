/**
 * F2-11: the weekly PUT refuses a stale save with a named 409.
 *
 * Two editors open the same week. The first saves (moving the revision);
 * the second saves with the now-stale revision and must get a 409 naming
 * the reload — with the first editor's hours intact (nothing lost). A save
 * with the fresh revision succeeds. Saves that predate the fence (no
 * expectedRevision) keep the old behavior so existing clients are
 * unaffected.
 *
 * DB-owned: drives the real PUT twice-over with two sessions against one
 * scratch week, asserting status codes, the named error, and the stored
 * rows after each step.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __weekRevision: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__weekRevision.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { PUT, GET } = await import('./route')

const WEEK = '2026-07-12'

function asUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: 'Week revision probe',
    email: `probe-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  } as SessionUser
}

async function fixture() {
  const org = await createScratchOrg()
  const editorA = await createScratchUser(org.orgId, 'Editor A', 'week_editor_a')
  const editorB = await createScratchUser(org.orgId, 'Editor B', 'week_editor_b')
  for (const key of ['week_editor_a', 'week_editor_b']) {
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key=${key}`)
  }
  const employee = randomUUID()
  const project = randomUUID()
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true },
    timesheets: { requireApproval: true },
    laborCosting: { mode: 'post', hoursPerDay: 8, annualHours: 2080, components: [] },
    controlAccounts: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank, laborWip: org.accounts.cogs, laborClearing: org.accounts.clearing },
  })}::jsonb where id=${org.orgId}`)
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${employee},${org.orgId},'employee','Revision worker',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${employee},true)`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'REV','Revision job',${org.customerId},'active',true,'{}'::jsonb)`)
  await db.execute(sql`insert into labor_cost_rates(org_id,employee_party_id,currency,rate,basis,effective_from,is_active)
    values (${org.orgId},${employee},'CAD','30','hour','2026-01-01',true)`)
  await db.execute(sql`update items set default_rate='100' where org_id=${org.orgId} and id=${org.items.service}`)
  const save = (userId: string, body: object) => {
    session.user = asUser(userId, org.orgId)
    return withOrgContext(org.orgId, () => PUT(new Request('http://probe.local/api/timesheets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee, week: WEEK, ...body }),
    })))
  }
  const snapshot = async () =>
    (await db.execute(sql`select hours::text as hours, worked_on::text as worked_on from time_entries
       where org_id=${org.orgId} order by worked_on, id`)).rows
  const close = async () => {
    session.user = null
    await dropScratchOrgReporting(org.orgId)
  }
  return { org, editorA, editorB, employee, project, serviceItem: org.items.service, save, snapshot, close }
}

const row = (project: string, item: string, hours: string[]) => ({
  projectId: project,
  itemId: item,
  isBillable: true,
  hours,
})

test('a stale weekly save gets a named 409 with nothing lost; a fresh save succeeds', async () => {
  const f = await fixture()
  try {
    // Both editors open the same empty week; the first save establishes
    // the revision the fence compares against.
    const first = await f.save(f.editorA, { rows: [row(f.project, f.serviceItem, ['8', '', '', '', '', '', ''])] })
    assert.equal(first.status, 200)
    const r1 = ((await first.json()) as { revision?: unknown }).revision
    assert.ok(typeof r1 === 'string' && r1.length > 0, 'the save response carries the week revision')

    // The GET the grid renders also carries it — the value the client sends back.
    session.user = asUser(f.editorA, f.org.orgId)
    const got = await withOrgContext(f.org.orgId, () =>
      GET(new Request(`http://probe.local/api/timesheets?employee=${f.employee}&week=${WEEK}`)))
    assert.equal(got.status, 200)
    assert.equal(((await got.json()) as { revision?: unknown }).revision, r1)

    // Editor A saves again with the fresh revision: accepted, new revision.
    const second = await f.save(f.editorA, {
      expectedRevision: r1,
      rows: [row(f.project, f.serviceItem, ['8', '4', '', '', '', '', ''])],
    })
    assert.equal(second.status, 200)
    const r2 = ((await second.json()) as { revision?: unknown }).revision
    assert.ok(typeof r2 === 'string' && r2 !== r1, 'a save that moves content moves the revision')

    // Editor B saves over the week with the now-stale revision: refused.
    const stale = await f.save(f.editorB, {
      expectedRevision: r1,
      rows: [row(f.project, f.serviceItem, ['', '', '8', '', '', '', ''])],
    })
    assert.equal(stale.status, 409)
    const refusal = (await stale.json()) as { error?: unknown; code?: unknown }
    assert.equal(refusal.code, 'timesheet_stale_revision')
    assert.match(String(refusal.error), /changed since you opened it/i, 'the refusal names the reload remedy')

    // Nothing lost: the week still holds exactly editor A's saved hours.
    assert.deepEqual(await f.snapshot(), [
      { hours: '8.0000', worked_on: '2026-07-12' },
      { hours: '4.0000', worked_on: '2026-07-13' },
    ])

    // Editor B reloads (fresh revision) and saves: accepted.
    const fresh = await f.save(f.editorB, {
      expectedRevision: r2,
      rows: [row(f.project, f.serviceItem, ['8', '4', '', '', '', '', ''])],
    })
    assert.equal(fresh.status, 200)
  } finally {
    await f.close()
  }
})

test('saves without a revision keep the old behavior', async () => {
  const f = await fixture()
  try {
    const res = await f.save(f.editorA, { rows: [row(f.project, f.serviceItem, ['8', '', '', '', '', '', ''])] })
    assert.equal(res.status, 200)
  } finally {
    await f.close()
  }
})
