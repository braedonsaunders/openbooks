import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { env, db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

const stateKey = Symbol.for('openbooks.file-bulk-route-test')
const state = { authz: null as {
  user: { id: string; orgId: string }
  permissions: Set<string>
  allowedSubsidiaryIds: null
} | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

// Faithful `can`: the bulk verdicts hinge on the documents.manage baseline
// (manager deletes, viewer is skipped), so the mock must honour the
// permission set rather than grant everything.
const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.file-bulk-route-test')]
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
    if (specifier === '../../../lib/authz') {
      return { shortCircuit: true, url: 'mock:file-bulk-authz' }
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
    if (url === 'mock:file-bulk-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeSpecifier: string = './route.ts?file-bulk-test'
const { POST } = (await import(routeSpecifier)) as typeof import('./route.ts')
hooks.deregister()

function bulkReq(body: unknown): Request {
  return new Request('https://meta.fixture/api/file-cabinet/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function isInactive(orgId: string, id: string): Promise<boolean | null> {
  const r = (await db.execute<{ isInactive: boolean }>(sql`
    select is_inactive as "isInactive" from files where id = ${id} and org_id = ${orgId}
  `))
  return r.rows[0]?.isInactive ?? null
}

/**
 * F4-2 (server half): the bulk response must carry the verdict per requested
 * id — not just counts — so the client can report a partial bulk as partial
 * and keep exactly the refused rows selected.
 */
test('bulk delete reports per-row verdicts with counts that add up', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = randomUUID()
  const folder = randomUUID()
  const fileA = randomUUID()
  const fileB = randomUUID()
  try {
    await db.execute(sql`
      insert into folders (id, org_id, parent_folder_id, name)
      values (${folder}, ${org.orgId}, null, 'F')
    `)
    await db.execute(sql`
      insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileA}, ${org.orgId}, ${folder}, 'a.txt', 'text/plain', 3),
             (${fileB}, ${org.orgId}, ${folder}, 'b.txt', 'text/plain', 3)
    `)

    // A documents.read caller is a viewer, not a manager: both rows refuse
    // with the access reason and nothing is trashed.
    state.authz = {
      user: { id: actorId, orgId: org.orgId },
      permissions: new Set(['documents.read']),
      allowedSubsidiaryIds: null,
    }
    {
      const res = await POST(bulkReq({ action: 'delete', fileIds: [fileA, fileB] }))
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean; done: number; skipped: number
        results: { id: string; kind: string; ok: boolean; error?: string }[]
      }
      assert.equal(body.ok, true)
      assert.equal(body.done, 0)
      assert.equal(body.skipped, 2)
      assert.deepEqual(
        body.results,
        [
          { id: fileA, kind: 'file', ok: false, error: 'forbidden' },
          { id: fileB, kind: 'file', ok: false, error: 'forbidden' },
        ],
      )
      assert.equal(await isInactive(org.orgId, fileA), false)
      assert.equal(await isInactive(org.orgId, fileB), false)
    }

    // A documents.manage caller trashes both rows with per-row success.
    state.authz = {
      user: { id: actorId, orgId: org.orgId },
      permissions: new Set(['documents.manage']),
      allowedSubsidiaryIds: null,
    }
    {
      const res = await POST(bulkReq({ action: 'delete', fileIds: [fileA, fileB] }))
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean; done: number; skipped: number
        results: { id: string; kind: string; ok: boolean; error?: string }[]
      }
      assert.equal(body.done, 2)
      assert.equal(body.skipped, 0)
      assert.deepEqual(
        body.results,
        [
          { id: fileA, kind: 'file', ok: true },
          { id: fileB, kind: 'file', ok: true },
        ],
      )
      assert.equal(await isInactive(org.orgId, fileA), true)
      assert.equal(await isInactive(org.orgId, fileB), true)
    }
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
