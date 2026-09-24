import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextRequest } from 'next/server'

// H-AUDITREC: GET /api/audit/record is the permission-before-existence
// class — it used to look the record up, 404 a missing id, and only then
// 403 a caller without the kind permission, so the 403/404 difference told
// an unauthorized caller whether the id exists. Now a caller holding none
// of the table family's permissions gets the same uniform 404 as a missing
// id, and a caller with the wrong kind permission gets that 404 too.
interface AuditState {
  recordExists: boolean
  permissions: string[]
}

const stateKey = Symbol.for('openbooks.audit-record-route-test')
const auditState: AuditState = { recordExists: true, permissions: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = auditState

const EXISTING_ID = '00000000-0000-4000-8000-00000000a001'
const MISSING_ID = '00000000-0000-4000-8000-00000000a002'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.audit-record-route-test')]
      export const db = {
        async execute(query) {
          const chunks = query?.queryChunks
          const text = Array.isArray(chunks)
            ? chunks.map((chunk) => Array.isArray(chunk?.value) ? chunk.value.map(String).join('') : '').join('')
            : ''
          if (text.includes('from documents')) {
            return state.recordExists
              ? { rows: [{ org_id: 'org-1', kind: 'vendor_bill', created_at: new Date(), created_by: null,
                           updated_at: new Date(), updated_by: null, subsidiaryId: null }] }
              : { rows: [] }
          }
          if (text.includes('count(*)')) return { rows: [{ n: 0 }] }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.audit-record-route-test')]
      export async function getAuthz() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: new Set(state.permissions) }
      }
      // Authorization-check double over the test's real permission sets.
      export function can(authz, perm) {
        return authz.permissions.has('*') || authz.permissions.has(perm)
      }
      export function guardSubsidiaryScope() {
        return null
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  // The canonical scope module loads for real: its denial shape is the
  // behavior under test, so doubling it would only prove the copy.
  ['../../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?audit-record-route-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function get(table: string, id: string): Promise<Response> {
  return GET(new NextRequest(`http://openbooks.test/api/audit/record?table=${table}&id=${id}`))
}

test('a caller with no document permission learns nothing from an existing id', async () => {
  auditState.recordExists = true
  auditState.permissions = []
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
})

test('the same caller gets the identical answer for a missing id', async () => {
  auditState.recordExists = false
  auditState.permissions = []
  const response = await get('documents', MISSING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
})

test('a caller with the wrong kind permission gets the uniform 404, not a 403', async () => {
  auditState.recordExists = true
  auditState.permissions = ['ar.read']
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
})

test('a caller with the kind permission still reads the record', async () => {
  auditState.recordExists = true
  auditState.permissions = ['ap.read']
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { recordType?: unknown }
  assert.equal(body.recordType, 'vendor_bill')
})
