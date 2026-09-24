import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Bulk mutations run every verb inside the route's single transaction and
// report per-item outcomes: unauthorized items are skipped, not fatal, and
// every applied verb leaves actor-attributed audit evidence. This drives the
// real route, real validation, and real storage against a scratch org — only
// the session boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const stateKey = Symbol.for('openbooks.file-cabinet-bulk-route-test')
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
      return { shortCircuit: true, url: 'mock:bulk-authz' }
    }
    if (specifier === '@/lib/api/json') {
      return nextResolve(jsonUrl, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:bulk-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.file-cabinet-bulk-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.authz }
          export async function guardPermission() { throw new Error('unreached in this test') }`,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?file-cabinet-bulk'
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
  return new Request('http://openbooks.test/api/file-cabinet/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function makeFolder(orgId: string, name: string): Promise<string> {
  const rows = (
    await db.execute<{ id: string }>(
      sql`insert into folders (org_id, parent_folder_id, name) values (${orgId}, null, ${name}) returning id`,
    )
  ).rows
  return rows[0]!.id
}

async function isInactive(orgId: string, id: string): Promise<boolean> {
  const rows = (
    await db.execute<{ is_inactive: boolean }>(
      sql`select is_inactive from folders where id = ${id} and org_id = ${orgId}`,
    )
  ).rows
  return rows[0]?.is_inactive === true
}

async function auditEvents(orgId: string, rowId: string): Promise<Array<{ actor: string; event: string }>> {
  const rows = (
    await db.execute<{ actor_id: string; event: string }>(
      sql`select actor_id, changes->>'event' as event from audit_log where org_id = ${orgId} and table_name = 'folders' and row_id = ${rowId} order by at`,
    )
  ).rows
  return rows.map((r) => ({ actor: r.actor_id, event: r.event }))
}

test('bulk delete trashes every folder and audits each with the actor', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const a = await makeFolder(org.orgId, 'A')
    const b = await makeFolder(org.orgId, 'B')

    const response = await POST(postRequest({ action: 'delete', folderIds: [a, b] }))

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      done: 2,
      skipped: 0,
      results: [
        { id: a, kind: 'folder', ok: true },
        { id: b, kind: 'folder', ok: true },
      ],
    })
    assert.equal(await isInactive(org.orgId, a), true)
    assert.equal(await isInactive(org.orgId, b), true)
    assert.deepEqual(await auditEvents(org.orgId, a), [{ actor: userId, event: 'delete' }])
    assert.deepEqual(await auditEvents(org.orgId, b), [{ actor: userId, event: 'delete' }])
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('bulk move relinks the folder and audits the move', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const target = await makeFolder(org.orgId, 'Target')
    const moving = await makeFolder(org.orgId, 'Moving')

    const response = await POST(
      postRequest({ action: 'move', folderIds: [moving], targetFolderId: target }),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      done: 1,
      skipped: 0,
      results: [{ id: moving, kind: 'folder', ok: true }],
    })
    const rows = (
      await db.execute<{ parent_folder_id: string | null }>(
        sql`select parent_folder_id from folders where id = ${moving} and org_id = ${org.orgId}`,
      )
    ).rows
    assert.equal(rows[0]?.parent_folder_id, target)
    assert.deepEqual(await auditEvents(org.orgId, moving), [{ actor: userId, event: 'move' }])
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('items below the caller tier are skipped without failing the batch', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    gate(org.orgId, randomUUID(), ['documents.read'])
    const a = await makeFolder(org.orgId, 'A')

    const response = await POST(postRequest({ action: 'delete', folderIds: [a] }))

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      done: 0,
      skipped: 1,
      results: [{ id: a, kind: 'folder', ok: false, error: 'forbidden' }],
    })
    assert.equal(await isInactive(org.orgId, a), false)
    assert.deepEqual(await auditEvents(org.orgId, a), [])
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})

test('an unknown action and an empty selection are refused before any write', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const userId = randomUUID()
  try {
    gate(org.orgId, userId, ['documents.manage'])
    const a = await makeFolder(org.orgId, 'A')

    const unknown = await POST(postRequest({ action: 'archive', folderIds: [a] }))
    assert.equal(unknown.status, 400)
    assert.deepEqual(await unknown.json(), { error: 'action must be delete or move' })

    const empty = await POST(postRequest({ action: 'delete', folderIds: [] }))
    assert.equal(empty.status, 400)
    assert.deepEqual(await empty.json(), { error: 'nothing selected' })

    const noTarget = await POST(postRequest({ action: 'move', folderIds: [a] }))
    assert.equal(noTarget.status, 400)
    assert.deepEqual(await noTarget.json(), { error: 'valid targetFolderId is required' })

    assert.equal(await isInactive(org.orgId, a), false)
    assert.deepEqual(await auditEvents(org.orgId, a), [])
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
})
