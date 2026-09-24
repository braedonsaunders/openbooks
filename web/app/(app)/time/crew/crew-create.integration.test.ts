/**
 * F2-1: the New Batch button (?new=1) opens the create workspace.
 *
 * Before the fix the loader read only sp.batch, so ?new=1 rendered the
 * list with no drawer — a dead click. Now ?new=1 (with time.crew.enter)
 * returns a createForm with the pickers the POST needs, opens the
 * workspace block, and the spec carries the create payload to the
 * hrm-crew-workspace widget. Without the permission the param is ignored.
 *
 * DB-owned: drives the real loader, the real spec builder and the real
 * batch POST, with an independent expected value at each step (the POSTed
 * batch must open by ?batch= afterwards).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __crewCreate: session })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en'}" }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function redirect(url){throw new Error('REDIRECT:'+url)};export function notFound(){throw new Error('NOT_FOUND')}" }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__crewCreate.user}' }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { loadCrewPage, crewSpec } = await import('./view')
const { POST } = await import('../../../api/time/crew-batches/route')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: 'Crew create probe',
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
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeCrewEntry": true}'::jsonb)
     where id = ${org.orgId}`)
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}',
      '{"roundingIncrement": 15, "roundingMode": "nearest", "unpaidBreakMinutes": 30,
        "autoCloseHours": 16, "signatureRequired": false, "equipmentToleranceHours": "1.0000",
        "photoRequired": false}'::jsonb)
     where id = ${org.orgId}`)
  const foremanUser = await createScratchUser(org.orgId, 'Foreman', 'crew_creator')
  const readerUser = await createScratchUser(org.orgId, 'Reader', 'crew_reader_nc')
  await db.execute(sql`
    update app_roles set permissions = '["time.read", "time.crew.enter"]'::jsonb
     where org_id = ${org.orgId} and key = 'crew_creator'`)
  await db.execute(sql`
    update app_roles set permissions = '["time.read"]'::jsonb
     where org_id = ${org.orgId} and key = 'crew_reader_nc'`)
  const foremanParty = randomUUID()
  const project = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${foremanParty},${org.orgId},'person','Crew Foreman',${org.subsidiaryId},true,'{}'::jsonb)`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},'JOB-NC','New crew job',${org.customerId},'active',true,'{}'::jsonb)`)
  // The realistic foreman path (no time.manage): the foreman is assigned to
  // the project crew through scheduling, which the batch POST requires.
  await db.execute(sql`insert into schedule_resources(org_id,project_id,party_id,name,kind)
    values (${org.orgId},${project},${foremanParty},'Crew Foreman','crew')`)
  const load = (userId: string, sp: Record<string, string | undefined>) => {
    session.user = asUser(userId, org.orgId)
    return withOrgContext(org.orgId, () => loadCrewPage(sp))
  }
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, foremanUser, readerUser, foremanParty, project, load, close }
}

function workspaceBlock(spec: ReturnType<typeof crewSpec>): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = node as Record<string, unknown>
    if (record.widget === 'hrm-crew-workspace') {
      found = (record.props ?? {}) as Record<string, unknown>
      return
    }
    for (const value of Object.values(record)) walk(value)
  }
  walk(spec)
  return found
}

test('?new=1 opens the create workspace with working pickers', async () => {
  const f = await fixture()
  try {
    const page = await f.load(f.foremanUser, { new: '1' })
    assert.equal(page.drawerOpen, true)
    assert.equal(page.workspace, null)
    assert.ok(page.createForm, 'the loader hands the create form to the drawer')
    assert.ok(
      page.createForm.workers.some((w) => w.id === f.foremanParty),
      'the foreman picker carries the seeded party',
    )
    assert.ok(
      page.createForm.projects.some((p) => p.id === f.project),
      'the project picker carries the seeded project',
    )
    assert.match(page.createForm.defaultWorkedOn, /^\d{4}-\d{2}-\d{2}$/)

    const props = workspaceBlock(crewSpec(page, '/time/crew'))
    assert.ok(props, 'the built spec renders the workspace block')
    assert.deepEqual(props.create, page.createForm)
    assert.equal(props.batchId, '')
  } finally {
    await f.close()
  }
})

test('?new=1 stays closed without time.crew.enter', async () => {
  const f = await fixture()
  try {
    const page = await f.load(f.readerUser, { new: '1' })
    assert.strictEqual(page.createForm, null)
    assert.strictEqual(page.drawerOpen, false)
  } finally {
    await f.close()
  }
})

test('the loader pickers satisfy the batch POST, and the batch opens by ?batch=', async () => {
  const f = await fixture()
  try {
    const page = await f.load(f.foremanUser, { new: '1' })
    assert.ok(page.createForm)
    const foreman = page.createForm.workers.find((w) => w.id === f.foremanParty)
    const project = page.createForm.projects.find((p) => p.id === f.project)
    assert.ok(foreman && project)

    session.user = asUser(f.foremanUser, f.org.orgId)
    const res = await withOrgContext(
      f.org.orgId,
      () =>
        POST(
          new Request('http://probe.local/api/time/crew-batches', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              foremanPartyId: foreman.id,
              projectId: project.id,
              workedOn: page.createForm!.defaultWorkedOn,
              notes: null,
            }),
          }),
        ),
    )
    assert.equal(res.status, 200)
    const id = ((await res.json()) as { id: string }).id
    assert.ok(id)

    const opened = await f.load(f.foremanUser, { batch: id })
    assert.equal(opened.drawerOpen, true)
    assert.equal(opened.createForm, null)
    assert.equal(
      (opened.workspace as { batchId?: string } | null)?.batchId,
      id,
      'the created batch opens in the workspace by ?batch=',
    )
  } finally {
    await f.close()
  }
})
