import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { env, db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

const stateKey = Symbol.for('openbooks.file-patch-route-test')
const state = { authz: null as {
  user: { id: string; orgId: string }
  permissions: Set<string>
  allowedSubsidiaryIds: null
} | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.file-patch-route-test')]
  export async function getAuthz() { return state.authz }
  export async function guardPermission() { return state.authz }
  export function can(authz, permission) {
    return authz?.permissions?.has('*') || authz?.permissions?.has(permission) || false
  }
  export function subsidiaryScopeAllows() { return true }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '../../../../../lib/authz' || specifier === '../../../lib/authz') {
      return { shortCircuit: true, url: 'mock:file-patch-authz' }
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
    if (url === 'mock:file-patch-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeSpecifier: string = './route.ts?file-patch-test'
const { PATCH } = (await import(routeSpecifier)) as typeof import('./route.ts')
hooks.deregister()

function patchReq(id: string, body: unknown): [Request, { params: Promise<{ id: string }> }] {
  const req = new Request(`https://meta.fixture/api/file-cabinet/files/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return [req, { params: Promise.resolve({ id }) }]
}

async function fileName(orgId: string, id: string): Promise<{ name: string; folderId: string } | null> {
  const r = (await db.execute<{ name: string; folderId: string }>(sql`
    select name, folder_id as "folderId" from files where id = ${id} and org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

/**
 * Regression coverage for the split-commit PATCH defect: the rename used to
 * commit (with its audit row) before the destination folder was validated, so
 * "valid name + invalid folderId" reported a failure with the rename already
 * stored. Both edits must validate up front and commit atomically.
 */
test('file rename+move validates up front and commits atomically', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = randomUUID()
  const folderA = randomUUID()
  const folderB = randomUUID()
  const fileId = randomUUID()
  state.authz = {
    user: { id: actorId, orgId: org.orgId },
    permissions: new Set(['documents.manage']),
    allowedSubsidiaryIds: null,
  }
  try {
    await db.execute(sql`
      insert into folders (id, org_id, parent_folder_id, name)
      values (${folderA}, ${org.orgId}, null, 'A'), (${folderB}, ${org.orgId}, null, 'B')
    `)
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderA}, 'orig.txt', 'text/plain', 3)
    `)

    // Valid name + malformed folderId: refused, and the name is unchanged.
    {
      const [req, ctx] = patchReq(fileId, { name: 'renamed.txt', folderId: 'not-a-uuid' })
      const res = await PATCH(req, ctx)
      assert.equal(res.status, 400)
      assert.equal((await fileName(org.orgId, fileId))?.name, 'orig.txt')
    }

    // Valid name + absent folderId: refused, and the name is unchanged.
    {
      const [req, ctx] = patchReq(fileId, { name: 'renamed.txt', folderId: randomUUID() })
      const res = await PATCH(req, ctx)
      assert.ok(res.status === 400 || res.status === 403, `status=${res.status}`)
      assert.equal((await fileName(org.orgId, fileId))?.name, 'orig.txt')
    }

    // Valid name + real destination: both apply together.
    {
      const [req, ctx] = patchReq(fileId, { name: 'moved.txt', folderId: folderB })
      const res = await PATCH(req, ctx)
      assert.equal(res.status, 200)
      assert.deepEqual(await fileName(org.orgId, fileId), { name: 'moved.txt', folderId: folderB })
    }

    // Rename-only still works on its own.
    {
      const [req, ctx] = patchReq(fileId, { name: 'solo.txt' })
      const res = await PATCH(req, ctx)
      assert.equal(res.status, 200)
      assert.equal((await fileName(org.orgId, fileId))?.name, 'solo.txt')
    }
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
