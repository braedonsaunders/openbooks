import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, env } from '@openbooks/engine/src/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/test-fixtures.ts'

const stateKey = Symbol.for('openbooks.file-upload-route-test')
const state = { authz: null as {
  user: { id: string; orgId: string }
  permissions: Set<string>
  allowedSubsidiaryIds: null
} | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.file-upload-route-test')]
  export async function getAuthz() { return state.authz }
  export async function guardPermission() { return state.authz ?? new Response(null, { status: 401 }) }
  export function can(authz, permission) { return authz?.permissions?.has(permission) ?? false }
  export function subsidiaryScopeAllows() { return true }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '../../../lib/authz' || specifier === '../../../../lib/authz') return { shortCircuit: true, url: 'mock:file-authz' }
    if (specifier.startsWith('@/') && context.parentURL) {
      const parentDir = decodeURIComponent(new URL('.', context.parentURL).href)
      const webRoot = parentDir.lastIndexOf('/web/')
      if (webRoot !== -1) return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + '.ts').href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:file-authz') return { format: 'module', source: mockAuthz, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeSpecifier: string = './route.ts?file-upload-test'
const { POST } = (await import(routeSpecifier)) as typeof import('./route.ts')
hooks.deregister()

test('file upload rolls back metadata when its audit append fails', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  const actorId = randomUUID()
  const folderId = randomUUID()
  state.authz = {
    user: { id: actorId, orgId: org.orgId },
    permissions: new Set(['*']),
    allowedSubsidiaryIds: null,
  }
  try {
    await db.execute(sql`
      insert into folders (id, org_id, parent_folder_id, name)
      values (${folderId}, ${org.orgId}, null, 'Uploads')
    `)
    await db.execute(sql.raw(`
      create function openbooks_test_block_upload_audit() returns trigger
      language plpgsql as $fn$ begin raise exception 'forced upload audit failure'; end $fn$
    `))
    await db.execute(sql.raw(`
      create trigger block_upload_audit before insert on audit_log for each row
      when (new.org_id = '${org.orgId}'::uuid and new.table_name = 'files'
            and new.changes->>'event' = 'upload')
      execute function openbooks_test_block_upload_audit()
    `))

    const form = new FormData()
    form.set('folderId', folderId)
    form.set('file', new File([Buffer.from('payload')], 'payload.txt', { type: 'text/plain' }))
    await assert.rejects(
      () => POST(new Request('http://openbooks.test/api/file-cabinet/files', { method: 'POST', body: form })),
      (error: unknown) => {
        const cause = (error as { cause?: unknown })?.cause
        return /forced upload audit failure/.test(String(cause || error))
      },
    )
    const failed = (await db.execute(sql`
      select count(*)::int as n from files where org_id = ${org.orgId} and folder_id = ${folderId}
    `)).rows[0]!
    assert.equal(failed.n, 0, 'an upload audit failure rolls back the file row')

    await db.execute(sql`drop trigger block_upload_audit on audit_log`)
    const retry = new FormData()
    retry.set('folderId', folderId)
    retry.set('file', new File([Buffer.from('payload')], 'payload.txt', { type: 'text/plain' }))
    const response = await POST(new Request('http://openbooks.test/api/file-cabinet/files', { method: 'POST', body: retry }))
    assert.equal(response.status, 201)
    const committed = (await db.execute(sql`
      select count(*)::int as n from files where org_id = ${org.orgId} and folder_id = ${folderId}
    `)).rows[0]!
    assert.equal(committed.n, 1)
  } finally {
    state.authz = null
    await db.execute(sql`drop trigger if exists block_upload_audit on audit_log`)
    await db.execute(sql`drop function if exists openbooks_test_block_upload_audit()`)
    await dropScratchOrg(org.orgId)
  }
})
