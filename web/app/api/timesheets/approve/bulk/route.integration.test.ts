import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../../lib/auth'

/**
 * Bulk approval decides each week in its own transaction through the
 * native approval command. Partial success is explicit per week — an
 * already-approved week reports its typed refusal beside the approved
 * ones, never silently and never aborting the rest.
 */
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __bulkApprove: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__bulkApprove.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')
const { POST: submitWeek } = await import('../../submit/route')
const { PUT } = await import('../../route')
const { loadWeek } = await import('../../_lib')

const WEEK = '2026-07-12'

async function fixture() {
  const org = await createScratchOrg()
  const supervisor = await createScratchUser(org.orgId, 'Approver', 'approver')
  await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`)
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features: { projects: false, timeTracking: true },
    timesheets: { requireApproval: true },
  })}::jsonb where id=${org.orgId}`)
  const workers: string[] = []
  for (const name of ['Crew One', 'Crew Two']) {
    const id = randomUUID()
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${id},${org.orgId},'employee',${name},${org.subsidiaryId},true,'{}'::jsonb)`)
    await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${id},true)`)
    workers.push(id)
  }
  session.user = { id: supervisor, orgId: org.orgId, name: 'Approver', email: 'approver@example.test', roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: supervisor }
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
  const bulk = (weeks: { employee: string; week: string }[]) => withOrgContext(org.orgId, () => POST(new Request('http://time.local/api/timesheets/approve/bulk', {
    method: 'POST', body: JSON.stringify({ weeks }),
  })))
  const close = async () => { session.user = null; await dropScratchOrgReporting(org.orgId) }
  return { org, supervisor, workers, save, submit, bulk, close }
}

test('bulk approval approves every submitted week', async () => {
  const f = await fixture()
  try {
    for (const worker of f.workers) {
      assert.equal((await f.save(worker)).status, 200)
      assert.equal((await f.submit(worker)).status, 200)
    }
    const response = await f.bulk(f.workers.map((employee) => ({ employee, week: WEEK })))
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as { results: { employee: string; week: string; ok: boolean }[] }
    assert.deepEqual(body.results.map((result) => result.ok), [true, true])
    const statuses = (await db.execute<{ status: string }>(sql`
      select status from time_entries where org_id=${f.org.orgId} order by employee_party_id`)).rows.map((row) => row.status)
    assert.deepEqual(statuses, ['approved', 'approved'])
  } finally { await f.close() }
})

test('bulk approval reports per-week refusals without aborting the rest', async () => {
  const f = await fixture()
  try {
    for (const worker of f.workers) {
      assert.equal((await f.save(worker)).status, 200)
      assert.equal((await f.submit(worker)).status, 200)
    }
    const [first, second] = f.workers as [string, string]
    assert.equal((await f.bulk([{ employee: first!, week: WEEK }])).status, 200)
    const response = await f.bulk([
      { employee: first!, week: WEEK },
      { employee: second!, week: WEEK },
    ])
    assert.equal(response.status, 200)
    const body = await response.json() as { results: { employee: string; week: string; ok: boolean; error?: string; code?: string; remedy?: string }[] }
    assert.equal(body.results.length, 2)
    assert.equal(body.results[0]!.ok, false)
    assert.equal(body.results[0]!.code, 'already_approved')
    assert.match(body.results[0]!.error ?? '', /already approved/)
    assert.ok((body.results[0]!.remedy ?? '').length > 0, 'the refusal carries its remedy')
    assert.equal(body.results[1]!.ok, true)
  } finally { await f.close() }
})

test('bulk approval refuses an empty or oversized batch', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.bulk([])).status, 422)
    const tooMany = Array.from({ length: 51 }, () => ({ employee: f.workers[0]!, week: WEEK }))
    assert.equal((await f.bulk(tooMany)).status, 422)
  } finally { await f.close() }
})
