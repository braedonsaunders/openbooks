import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Replacing a file must point the file at a new version while preserving the
// old one, with actor-attributed audit evidence — and refuse non-files,
// disallowed types, and malformed ids before touching storage. This drives
// the real route, real validation, and real storage against a scratch org:
// only the session boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const stateKey = Symbol.for('openbooks.file-cabinet-replace-route-test')
const state: {
  authz: {
    user: { id: string; orgId: string }
    permissions: Set<string>
    allowedSubsidiaryIds: null
  } | null
} = { authz: null }
;(globalThis as Record<symbol, unknown>)[stateKey] = state

const permissionsUrl = new URL('../../../../../../lib/permissions.ts', import.meta.url).href
const subsidiaryScopeUrl = new URL(
  '../../../../../../../engine/src/organization/subsidiary-scope.ts',
  import.meta.url,
).href
const jsonUrl = new URL('../../../../../../lib/api/json.ts', import.meta.url).href

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/authz' || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: 'mock:replace-authz' }
    }
    if (specifier === '@/lib/api/json') {
      return nextResolve(jsonUrl, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:replace-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.file-cabinet-replace-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?file-cabinet-replace'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
const { createFile } = await import('../../../../../../lib/file-cabinet')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

function gate(orgId: string, userId: string, permissions: string[]) {
  state.authz = {
    user: { id: userId, orgId },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  }
}

function postRequest(id: string, file: File | null): Request {
  const form = new FormData()
  if (file) form.set('file', file)
  return new Request(`http://openbooks.test/api/file-cabinet/files/${id}/replace`, {
    method: 'POST',
    body: form,
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function seedFile(orgId: string, folderId: string, userId: string): Promise<string> {
  const meta = await createFile({
    orgId,
    folderId,
    filename: 'v1.csv',
    contentType: 'text/csv',
    bytes: Buffer.from('a,b\n1,2\n'),
    createdBy: userId,
  })
  return meta.id
}

async function versionCount(orgId: string, fileId: string): Promise<number> {
  const rows = (
    await db.execute<{ n: string }>(
      sql`select count(*)::text as n from file_versions fv join files fi on fi.id = fv.file_id and fi.org_id = ${orgId} where fv.file_id = ${fileId}`,
    )
  ).rows
  return Number(rows[0]?.n ?? 0)
}

test('a replace stores a new version, keeps the old one, and audits the actor', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const folder = (
      await db.execute<{ id: string }>(
        sql`insert into folders (org_id, parent_folder_id, name) values (${org.orgId}, null, 'F') returning id`,
      )
    ).rows[0]!.id
    const fileId = await seedFile(org.orgId, folder, userId)
    assert.equal(await versionCount(org.orgId, fileId), 1)

    const response = await POST(
      postRequest(fileId, new File(['a,b\n3,4\n'], 'v2.csv', { type: 'text/csv' })),
      ctx(fileId),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(await versionCount(org.orgId, fileId), 2)
    const current = (
      await db.execute<{ content_type: string; size_bytes: number }>(
        sql`select content_type, size_bytes from files where id = ${fileId} and org_id = ${org.orgId}`,
      )
    ).rows[0]!
    assert.equal(current.content_type, 'text/csv')
    assert.equal(current.size_bytes, 8)
    const audits = (
      await db.execute<{ actor_id: string; event: string }>(
        sql`select actor_id, changes->>'event' as event from audit_log where org_id = ${org.orgId} and table_name = 'files' and row_id = ${fileId}`,
      )
    ).rows
    assert.deepEqual(audits, [{ actor_id: userId, event: 'replace' }])
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a malformed id is a 404 that stores nothing', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['documents.manage'])

    const response = await POST(
      postRequest('nope', new File(['a'], 'v.csv', { type: 'text/csv' })),
      ctx('nope'),
    )

    assert.equal(response.status, 404)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a missing part and a disallowed type are refused with names', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const folder = (
      await db.execute<{ id: string }>(
        sql`insert into folders (org_id, parent_folder_id, name) values (${org.orgId}, null, 'F') returning id`,
      )
    ).rows[0]!.id
    const fileId = await seedFile(org.orgId, folder, userId)

    const missing = await POST(postRequest(fileId, null), ctx(fileId))
    assert.equal(missing.status, 400)
    assert.deepEqual(await missing.json(), { error: 'file is required' })

    const blocked = await POST(
      postRequest(fileId, new File(['x'], 'run.exe', { type: 'application/x-msdownload' })),
      ctx(fileId),
    )
    assert.equal(blocked.status, 415)
    assert.match((await blocked.json() as { error: string }).error, /unsupported file type/)

    assert.equal(await versionCount(org.orgId, fileId), 1)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
