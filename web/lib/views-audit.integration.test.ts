import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Saved-view edits and deletes mutated rows with no audit evidence while
// create audited; an owner sharing a view with roles excluding their own
// locked themselves out of every later read; and {"name": 42} reached
// name.trim() as a 500. Edits/deletes now audit before/after (deletion
// snapshot) in the same transaction, the owner always retains access, and
// mistyped fields refuse naming the field.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __viewsAuditState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__viewsAuditState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['reports.create', 'reports.read']) };
      }
    `)
    if (specifier === '../../../../lib/report-authz') return virtual(`
      export async function canRunReportEntity() { return true }
      export async function guardReportEntity() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createView, deleteView, loadView, updateView } = await import('./views.ts')
const { PATCH } = await import('../app/api/views/[id]/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL
const NO_PERMS = new Set<string>()

// Direct reads run under the org's own scope: with request-org loaded, the
// ambient test bypass is replaced, so an unscoped SELECT silently returns
// zero rows and the audit assertions would pass/fail on nothing.
async function audits(orgId: string, rowId: string) {
  return withOrgContext(orgId, async () => (await db.execute<{ action: string; changes: unknown; actor_id: string }>(sql`
    select action, changes, actor_id from audit_log
     where org_id = ${orgId} and table_name = 'saved_views' and row_id = ${rowId}
     order by at`)).rows)
}

test('view edits and deletes audit before/after in the same transaction', { skip: !DB }, async () => {
  // Fixture writes run inside the approved bypass scope: this file reaches
  // request-org through the route import, which replaces the ambient test
  // bypass, so unscoped writes would die on RLS (inserts) or silently match
  // zero rows (updates/deletes).
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    const { id } = await createView({ orgId: org.orgId, userId: actorId, name: 'Audited view' })

    const renamed = await updateView(org.orgId, id, actorId, false, { name: 'Renamed view' })
    assert.deepEqual(renamed, { ok: true })
    const editAudits = await audits(org.orgId, id)
    assert.equal(editAudits.length, 1, 'the edit writes exactly one audit row')
    assert.equal(editAudits[0]!.action, 'update')
    const changes = editAudits[0]!.changes as { before: { name: string }; after: { name: string } }
    assert.equal(changes.before.name, 'Audited view')
    assert.equal(changes.after.name, 'Renamed view')
    assert.equal(editAudits[0]!.actor_id, actorId)

    assert.equal(await deleteView(org.orgId, id, actorId, false), true)
    const all = await audits(org.orgId, id)
    assert.equal(all.length, 2, 'the delete adds its own audit row')
    assert.equal(all[1]!.action, 'delete')
    assert.equal((all[1]!.changes as { before: { name: string } }).before.name, 'Renamed view')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('an owner sharing a view with foreign roles keeps their own access', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    const { id } = await createView({ orgId: org.orgId, userId: actorId, name: 'Shared view' })
    const shared = await updateView(org.orgId, id, actorId, false, {
      scope: 'shared',
      allowedRoles: ['a-role-the-owner-does-not-hold'],
    })
    assert.deepEqual(shared, { ok: true })
    const view = await loadView(org.orgId, id, actorId, NO_PERMS)
    assert.ok(view, 'the owner still reads their own restricted-shared view')
    assert.equal(view!.scope, 'shared')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('mistyped view fields refuse naming the field, never 500', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    const { id } = await createView({ orgId: org.orgId, userId: actorId, name: 'Typed view' })
    for (const [field, patch] of [
      ['name', { name: 42 }],
      ['description', { description: 42 }],
      ['scope', { scope: 'everyone' }],
      ['allowedRoles', { allowedRoles: 'admin' }],
    ] as const) {
      const res = await updateView(org.orgId, id, actorId, false, patch as never)
      assert.equal(res.ok, false, `${field} must refuse`)
      assert.match(
        (res as { error: string }).error,
        new RegExp(field === 'scope' ? 'scope' : field === 'allowedRoles' ? 'allowedRoles' : field),
        `${field} refusal names the field`,
      )
    }
    const view = await loadView(org.orgId, id, actorId, NO_PERMS)
    assert.equal(view!.name, 'Typed view', 'refused edits change nothing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH {"name": 42} answers 422 naming the field', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  state.orgId = org.orgId
  state.actorId = actorId
  try {
    const { id } = await createView({ orgId: org.orgId, userId: actorId, name: 'Route view' })
    const response = await PATCH(
      new Request(`http://openbooks.test/api/views/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      }),
      { params: Promise.resolve({ id }) },
    )
    const body = (await response.json()) as { error?: string }
    assert.equal(response.status, 422, `mistyped field must be a 422, not a 500: ${JSON.stringify(body)}`)
    assert.match(body.error ?? '', /name/i)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
