import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

const stateKey = Symbol.for('openbooks.folder-route-test')
const state = { authz: null as {
  user: { id: string; orgId: string }
  permissions: Set<string>
  allowedSubsidiaryIds: null
} | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.folder-route-test')]
  export async function getAuthz() { return state.authz }
  export async function guardPermission() { return state.authz ?? new Response(null, { status: 401 }) }
  export function can(authz, permission) { return authz?.permissions?.has(permission) ?? false }
  export function subsidiaryScopeAllows() { return true }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../../../../lib/authz' || specifier === '../../../lib/authz' ||
      (specifier === '@/lib/authz' && context.parentURL?.includes('/web/lib/api/route.ts'))) {
      return { shortCircuit: true, url: 'mock:folder-authz' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:folder-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeSpecifier: string = './route.ts?folder-compound-test'
const { PATCH } = (await import(routeSpecifier)) as typeof import('./route.ts')

test('compound folder edits validate and audit as one transaction', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const actorId = randomUUID()
  const targetId = randomUUID()
  const destinationId = randomUUID()
  const movableId = randomUUID()
  state.authz = {
    user: { id: actorId, orgId: org.orgId },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: null,
  }
  try {
    const folders = await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into folders (id, org_id, parent_folder_id, name, is_system)
      values (${targetId}, ${org.orgId}, null, 'Attachments', true),
             (${destinationId}, ${org.orgId}, null, 'Destination', false),
             (${movableId}, ${org.orgId}, null, 'Movable', false)
      returning id
    `))
    assert.deepEqual(new Set(folders.rows.map((row) => row.id)), new Set([targetId, destinationId, movableId]),
      'the three folder fixtures must be created before testing compound edits')

    const response = await PATCH(
      new Request('http://openbooks.test/api/file-cabinet/folders/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: destinationId, name: 'Renamed system folder' }),
      }),
      { params: Promise.resolve({ id: targetId }) },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'cannot rename system folder' })

    const row = (await db.execute<{ parentId: string | null; name: string }>(sql`
      select parent_folder_id as "parentId", name from folders where id = ${targetId} and org_id = ${org.orgId}
    `)).rows[0]!
    assert.equal(row.parentId, null, 'the failed rename did not leave the move committed')
    assert.equal(row.name, 'Attachments')
    const audit = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log where org_id = ${org.orgId} and table_name = 'folders' and row_id = ${targetId}
    `)).rows[0]!
    assert.equal(audit.n, 0, 'a rejected compound edit leaves no activity evidence')

    const success = await PATCH(
      new Request('http://openbooks.test/api/file-cabinet/folders/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: destinationId, name: 'Moved folder' }),
      }),
      { params: Promise.resolve({ id: movableId }) },
    )
    assert.equal(success.status, 200)
    const moved = (await db.execute<{ parentId: string | null; name: string }>(sql`
      select parent_folder_id as "parentId", name from folders where id = ${movableId} and org_id = ${org.orgId}
    `)).rows[0]!
    assert.equal(moved.parentId, destinationId)
    assert.equal(moved.name, 'Moved folder')
    const successAudit = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log where org_id = ${org.orgId} and table_name = 'folders' and row_id = ${movableId}
    `)).rows[0]!
    assert.equal(successAudit.n, 2, 'move and rename evidence commit with the compound edit')

    // An explicit move to the cabinet root publishes to every documents.read
    // user: a Manager grant on the folder alone must not allow it.
    const scopedId = randomUUID()
    const scopedFolder = await withBypassContext(() => db.execute<{ id: string }>(sql`
      insert into folders (id, org_id, parent_folder_id, name, is_system)
      values (${scopedId}, ${org.orgId}, ${destinationId}, 'Scoped child', false)
      returning id
    `))
    assert.equal(scopedFolder.rows.length, 1, 'the scoped child folder must exist before testing root-move refusal')
    assert.equal(scopedFolder.rows[0]?.id, scopedId)
    const folderGrant = await withBypassContext(() => db.execute<{ resource_id: string }>(sql`
      insert into resource_grants (org_id, resource_type, resource_id, principal_type, principal_id, access, created_by)
      values (${org.orgId}, 'folder', ${scopedId}, 'user', ${actorId}, 'manager', ${actorId})
      returning resource_id
    `))
    assert.equal(folderGrant.rows.length, 1, 'the manager grant must exist before testing root-move refusal')
    assert.equal(folderGrant.rows[0]?.resource_id, scopedId)
    state.authz = {
      user: { id: actorId, orgId: org.orgId },
      permissions: new Set(['documents.read']),
      allowedSubsidiaryIds: null,
    }
    const rooted = await PATCH(
      new Request('http://openbooks.test/api/file-cabinet/folders/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: null, name: 'Renamed' }),
      }),
      { params: Promise.resolve({ id: scopedId }) },
    )
    assert.equal(rooted.status, 403)
    const stayed = (await db.execute<{ parentId: string | null }>(sql`
      select parent_folder_id as "parentId" from folders where id = ${scopedId} and org_id = ${org.orgId}
    `)).rows[0]!
    assert.equal(stayed.parentId, destinationId, 'a refused root move leaves the folder parented')
    state.authz = {
      user: { id: actorId, orgId: org.orgId },
      permissions: new Set(['*']),
      allowedSubsidiaryIds: null,
    }

    const cascadeRequired = await PATCH(
      new Request('http://openbooks.test/api/file-cabinet/folders/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isInactive: true }),
      }),
      { params: Promise.resolve({ id: movableId }) },
    )
    assert.equal(cascadeRequired.status, 400)
    assert.match((await cascadeRequired.json()).error, /use DELETE to trash the subtree/)
    const remainsActive = (await db.execute<{ isInactive: boolean }>(sql`
      select is_inactive as "isInactive" from folders where id = ${movableId} and org_id = ${org.orgId}
    `)).rows[0]!
    assert.equal(remainsActive.isInactive, false, 'PATCH must not trash just the root folder')
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
