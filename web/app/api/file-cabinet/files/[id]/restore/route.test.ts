import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Restoring a trashed file must flip it back to active with actor-attributed
// audit evidence — and a malformed id must 404 before anything is read. This
// drives the real route, real validation, and real storage against a scratch
// org: only the session boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const stateKey = Symbol.for('openbooks.file-cabinet-restore-route-test')
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
      return { shortCircuit: true, url: 'mock:restore-authz' }
    }
    if (specifier === '@/lib/api/json') {
      return nextResolve(jsonUrl, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:restore-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.file-cabinet-restore-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?file-cabinet-restore'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
const { createFile, deleteFile } = await import('../../../../../../lib/file-cabinet')
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

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function fileActive(orgId: string, fileId: string): Promise<boolean | null> {
  const rows = (
    await db.execute<{ is_inactive: boolean }>(
      sql`select is_inactive from files where id = ${fileId} and org_id = ${orgId}`,
    )
  ).rows
  if (rows.length === 0) return null
  return rows[0]!.is_inactive === false
}

test('a restore flips a trashed file back to active with actor audit', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const folder = (
      await db.execute<{ id: string }>(
        sql`insert into folders (org_id, parent_folder_id, name) values (${org.orgId}, null, 'F') returning id`,
      )
    ).rows[0]!.id
    const meta = await createFile({
      orgId: org.orgId,
      folderId: folder,
      filename: 'v1.csv',
      contentType: 'text/csv',
      bytes: Buffer.from('a,b\n1,2\n'),
      createdBy: userId,
    })
    assert.equal(await deleteFile(org.orgId, meta.id), true)
    assert.equal(await fileActive(org.orgId, meta.id), false)

    const response = await POST(
      new Request(`http://openbooks.test/api/file-cabinet/files/${meta.id}/restore`, {
        method: 'POST',
      }),
      ctx(meta.id),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(await fileActive(org.orgId, meta.id), true)
    const audits = (
      await db.execute<{ actor_id: string; event: string }>(
        sql`select actor_id, changes->>'event' as event from audit_log where org_id = ${org.orgId} and table_name = 'files' and row_id = ${meta.id} order by at`,
      )
    ).rows
    assert.deepEqual(
      audits.map((a) => a.event),
      ['restore'],
    )
    assert.ok(audits.every((a) => a.actor_id === userId))
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a malformed id is a 404 that restores nothing', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['documents.manage'])

    const response = await POST(
      new Request('http://openbooks.test/api/file-cabinet/files/nope/restore', {
        method: 'POST',
      }),
      ctx('nope'),
    )

    assert.equal(response.status, 404)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('restoring an active file is a named not-found, not a duplicate audit', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const folder = (
      await db.execute<{ id: string }>(
        sql`insert into folders (org_id, parent_folder_id, name) values (${org.orgId}, null, 'F') returning id`,
      )
    ).rows[0]!.id
    const meta = await createFile({
      orgId: org.orgId,
      folderId: folder,
      filename: 'v1.csv',
      contentType: 'text/csv',
      bytes: Buffer.from('a,b\n1,2\n'),
      createdBy: userId,
    })

    const response = await POST(
      new Request(`http://openbooks.test/api/file-cabinet/files/${meta.id}/restore`, {
        method: 'POST',
      }),
      ctx(meta.id),
    )

    assert.equal(response.status, 404)
    const audits = (
      await db.execute<{ n: string }>(
        sql`select count(*)::text as n from audit_log where org_id = ${org.orgId} and table_name = 'files' and row_id = ${meta.id} and changes->>'event' = 'restore'`,
      )
    ).rows
    assert.equal(Number(audits[0]?.n ?? 0), 0)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
