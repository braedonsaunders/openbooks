import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Folder creation must persist the row and its actor-attributed audit event
// together, and refuse a blank name (or a missing manage grant) before
// anything is written. This drives the real route, real validation, and real
// storage against a scratch org: only the session boundary is stubbed. The
// permission check itself runs for real — fileViewer derives the baseline
// from the stubbed gate through the real permission-cover logic.

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const stateKey = Symbol.for('openbooks.file-cabinet-folders-route-test')
const state: {
  authz: {
    user: { id: string; orgId: string }
    permissions: Set<string>
    allowedSubsidiaryIds: null
  } | null
} = { authz: null }
;(globalThis as Record<symbol, unknown>)[stateKey] = state

const permissionsUrl = new URL('../../../../lib/permissions.ts', import.meta.url).href
const subsidiaryScopeUrl = new URL(
  '../../../../../engine/src/organization/subsidiary-scope.ts',
  import.meta.url,
).href
const jsonUrl = new URL('../../../../lib/api/json.ts', import.meta.url).href

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/authz' || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: 'mock:folders-authz' }
    }
    if (specifier === '@/lib/api/json') {
      return nextResolve(jsonUrl, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:folders-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.file-cabinet-folders-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?file-cabinet-folders'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
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

function postRequest(body: unknown): Request {
  return new Request('http://openbooks.test/api/file-cabinet/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function folderCount(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from folders where org_id = ${orgId}`,
  )
  return Number(rows.rows[0]?.n ?? 0)
}

async function auditCount(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from audit_log where org_id = ${orgId}`,
  )
  return Number(rows.rows[0]?.n ?? 0)
}

test('creating a folder stores the row and an actor-attributed audit event', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])

    const response = await POST(postRequest({ name: 'Legal' }))

    assert.equal(response.status, 201)
    const body = (await response.json()) as { id?: string }
    assert.ok(typeof body.id === 'string' && body.id.length > 0)
    const rows = (
      await db.execute<{
        name: string
        parent_folder_id: string | null
        created_by: string
      }>(sql`select name, parent_folder_id, created_by from folders where id = ${body.id} and org_id = ${org.orgId}`)
    ).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.name, 'Legal')
    assert.equal(rows[0]?.parent_folder_id, null)
    assert.equal(rows[0]?.created_by, userId)
    const audits = (
      await db.execute<{ actor_id: string; action: string; event: string }>(
        sql`select actor_id, action, changes->>'event' as event from audit_log where org_id = ${org.orgId} and table_name = 'folders' and row_id = ${body.id}`,
      )
    ).rows
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.actor_id, userId)
    assert.equal(audits[0]?.action, 'insert')
    assert.equal(audits[0]?.event, 'create')
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a blank name is refused before anything is written', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['documents.manage'])

    const response = await POST(postRequest({ name: '  ' }))

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'name is required' })
    assert.equal(await folderCount(org.orgId), 0)
    assert.equal(await auditCount(org.orgId), 0)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a caller without the manage grant cannot create a top-level folder', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['documents.read'])

    const response = await POST(postRequest({ name: 'Legal' }))

    assert.equal(response.status, 403)
    assert.equal(await folderCount(org.orgId), 0)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('a sub-folder links to its parent', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])

    const parent = (await (await POST(postRequest({ name: 'Matters' }))).json()) as { id: string }
    const response = await POST(postRequest({ name: 'Acme', parentId: parent.id }))

    assert.equal(response.status, 201)
    const body = (await response.json()) as { id: string }
    const rows = (
      await db.execute<{ parent_folder_id: string | null }>(
        sql`select parent_folder_id from folders where id = ${body.id} and org_id = ${org.orgId}`,
      )
    ).rows
    assert.equal(rows[0]?.parent_folder_id, parent.id)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
