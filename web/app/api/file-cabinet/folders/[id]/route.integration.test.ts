import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { env, db } from '@openbooks/engine/src/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/test-fixtures.ts'

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

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '../../../../../lib/authz' || specifier === '../../../lib/authz') {
      return { shortCircuit: true, url: 'mock:folder-authz' }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const parentDir = decodeURIComponent(new URL('.', context.parentURL).href)
      const webRoot = parentDir.lastIndexOf('/web/')
      if (webRoot !== -1) {
        return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + '.ts').href, context)
      }
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
hooks.deregister()

test('compound folder edits validate and audit as one transaction', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
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
    await db.execute(sql`
      insert into folders (id, org_id, parent_folder_id, name, is_system)
      values (${targetId}, ${org.orgId}, null, 'Attachments', true),
             (${destinationId}, ${org.orgId}, null, 'Destination', false),
             (${movableId}, ${org.orgId}, null, 'Movable', false)
    `)

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
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
