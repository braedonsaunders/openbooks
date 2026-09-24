import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Manual flow triggers enforce the SUBJECT's action authority, independent
 * of the trigger's optional requirePermission.
 *
 * A manual button whose branch sets a field (or changes status, posts, …)
 * needs the subject kind's edit/post grant — not just the trigger's
 * requirePermission, which may be unset. A read-only role (ap.read, no
 * ap.create) must not see the button and must meet the same unavailability
 * refusal as for a missing button, with no flow run left behind. Only the
 * session is stubbed; handler, permission resolution, planning and the
 * engine are real.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __manualFlowPermissionsUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__manualFlowPermissionsUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg, seedDraftDocument } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'tester', email: `tester-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId,
    homeOrgId: orgId, homeUserId: id,
  }
}

async function enableFlows(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"flows":true}'::jsonb, true)
      where id = ${orgId}`),
  )
}

/** A manual button with NO requirePermission, wired to a field write. */
async function seedTagManualFlow(orgId: string): Promise<void> {
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'trigger', position: { x: 0, y: 0 },
        data: { kind: 'trigger', trigger: { trigger: 'manual', buttonId: 'tag', label: 'Tag' } },
      },
      {
        id: 'set', position: { x: 220, y: 0 },
        data: {
          kind: 'action',
          action: { action: 'set_field', field: 'memo', value: { kind: 'literal', value: 'tagged' } },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'set', sourceHandle: 'next' }],
  }
  await withBypassContext(() =>
    db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${orgId}, 'Manual tag flow', 'vendor_bill', true,
              ${JSON.stringify(graph)}::jsonb)`),
  )
}

/** A role key with exactly the given permission grants. */
async function seedRole(orgId: string, key: string, permissions: string[]): Promise<void> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`))
  state.user = sessionUser(userId, orgId)
}

async function runCount(orgId: string, subjectId: string): Promise<number> {
  const rows = (await withBypassContext(() => db.execute<{ n: string }>(sql`
    select count(*) as n from flow_runs where org_id = ${orgId} and subject_id = ${subjectId}`)))
  return Number(rows.rows[0]?.n ?? 0)
}

async function billMemo(orgId: string, id: string): Promise<string | null> {
  const rows = (await withBypassContext(() => db.execute<{ memo: string | null }>(sql`
    select memo from documents where id = ${id} and org_id = ${orgId}`)))
  return rows.rows[0]?.memo ?? null
}

test('a read-only role is refused a field-writing manual trigger', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFlows(org.orgId)
    await seedTagManualFlow(org.orgId)
    const maker = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: 'vendor_bill', createdBy: maker }))
    await seedRole(org.orgId, 'bill_reader', ['ap.read'])

    const list = await withOrgContext(org.orgId, () =>
      GET(new Request(
        `http://manual.test/api/flows/manual?subjectKind=vendor_bill&subjectId=${docId}`,
      )))
    assert.equal(list.status, 200)
    assert.deepEqual(
      (await list.json() as { buttons: unknown[] }).buttons, [],
      'the field-writing button stays hidden without edit authority',
    )

    const res = await withOrgContext(org.orgId, () =>
      POST(new Request('http://manual.test/api/flows/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectKind: 'vendor_bill', subjectId: docId, buttonId: 'tag' }),
      })))
    if (res.status !== 404) {
      assert.fail(`read-only manual POST must be 404 unavailability, got ${res.status}: ${JSON.stringify(await res.json())}`)
    }
    assert.match(
      ((await res.json()) as { error?: string }).error ?? '',
      /not available/,
      'the refusal reads exactly like a missing button',
    )
    assert.equal(await runCount(org.orgId, docId), 0, 'no flow run may start')
    assert.equal(await billMemo(org.orgId, docId), null, 'the field is untouched')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an edit grant runs the same trigger and writes the field', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFlows(org.orgId)
    await seedTagManualFlow(org.orgId)
    const maker = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: 'vendor_bill', createdBy: maker }))
    await seedRole(org.orgId, 'bill_editor', ['ap.read', 'ap.create'])

    const list = await withOrgContext(org.orgId, () =>
      GET(new Request(
        `http://manual.test/api/flows/manual?subjectKind=vendor_bill&subjectId=${docId}`,
      )))
    assert.equal(list.status, 200)
    assert.deepEqual(
      ((await list.json()) as { buttons: { buttonId: string }[] }).buttons.map((b) => b.buttonId),
      ['tag'],
      'the button is offered with edit authority',
    )

    const res = await withOrgContext(org.orgId, () =>
      POST(new Request('http://manual.test/api/flows/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectKind: 'vendor_bill', subjectId: docId, buttonId: 'tag' }),
      })))
    assert.equal(res.status, 200, `edit-granted POST must dispatch: ${JSON.stringify(await res.clone().json())}`)
    assert.equal(((await res.json()) as { ok?: boolean }).ok, true)
    assert.equal(await billMemo(org.orgId, docId), 'tagged')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an edit grant outside the record subsidiary still cannot run it', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFlows(org.orgId)
    await seedTagManualFlow(org.orgId)
    const maker = await withBypassContext(() => createScratchUser(org.orgId, 'maker', 'maker'))
    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: 'vendor_bill', createdBy: maker }))
    const branch = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Manual Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`))
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'branch editor', 'branch_editor'))
    await withBypassContext(() => db.execute(sql`
      update app_roles set permissions = '["ap.read", "ap.create"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [branch] })}::jsonb
       where org_id = ${org.orgId} and key = 'branch_editor'`))
    state.user = sessionUser(userId, org.orgId)

    const list = await withOrgContext(org.orgId, () =>
      GET(new Request(
        `http://manual.test/api/flows/manual?subjectKind=vendor_bill&subjectId=${docId}`,
      )))
    assert.equal(list.status, 404, 'out-of-scope manual GET answers as missing')

    const res = await withOrgContext(org.orgId, () =>
      POST(new Request('http://manual.test/api/flows/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectKind: 'vendor_bill', subjectId: docId, buttonId: 'tag' }),
      })))
    assert.equal(res.status, 404, 'out-of-scope manual POST answers as missing')
    assert.equal(await runCount(org.orgId, docId), 0, 'no flow run may start')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
