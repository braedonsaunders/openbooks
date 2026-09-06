import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for DELETE /api/file-cabinet/attachments/[id]. The
// REAL handler and the real attachment gate helpers run against scripted
// authz, a scripted target lookup and a spied cabinet service. Detaching is a
// mutation of a record's evidence, so it must apply the SAME target
// visibility (subsidiary scope + owning-record permission) the listing route
// applies, and it must surface the service's retention refusal instead of
// silently succeeding.

const stateKey = Symbol.for('openbooks.file-cabinet-attachment-detach-route-test')
const attachmentId = '00000000-0000-4000-8000-000000000011'
const targetId = '00000000-0000-4000-8000-000000000001'
const fileId = '00000000-0000-4000-8000-000000000002'

interface RouteState {
  permissions: Set<string>
  allowedSubsidiaryIds: Set<string> | null
  link: { id: string; fileId: string; targetTable: string; targetId: string } | null
  targetRows: unknown[]
  detachResult: { ok: true } | { ok: false; reason: 'not found' | 'retained' }
  detachCalls: unknown[][]
  permissionChecks: string[]
}

const routeState: RouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  link: null,
  targetRows: [],
  detachResult: { ok: true },
  detachCalls: [],
  permissionChecks: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachment-detach-route-test')]
      export const db = {
        execute() { return Promise.resolve({ rows: state.targetRows.shift() ?? [] }) },
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachment-detach-route-test')]
      export async function getAuthz() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(state.permissions),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export function can(authz, permission) {
        state.permissionChecks.push(permission)
        return authz.permissions.has(permission) || authz.permissions.has('*')
      }
      export function subsidiaryScopeAllows(scope, subsidiaryId, opts = {}) {
        if (scope === null) return true
        if (subsidiaryId == null || subsidiaryId === '') return opts.orgWideNull === true
        return scope.has(subsidiaryId)
      }
    `,
  ],
  [
    'mock:file-cabinet',
    `
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachment-detach-route-test')]
      export async function getAttachmentLink() { return state.link }
      export async function detachAttachment(...args) {
        state.detachCalls.push(args)
        return state.detachResult
      }
      export async function listAttachments() { return [] }
      export async function getFile() { return null }
      export function accessAtLeast() { return true }
      export async function fileAccessLevel() { return 'viewer' }
      export async function folderAccessLevel() { return 'viewer' }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/file-cabinet', 'mock:file-cabinet'],
  ['../../../lib/file-cabinet', 'mock:file-cabinet'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { DELETE } = (await import('./route.ts')) as typeof import('./route.ts')
hooks.deregister()

function reset(input: {
  permissions: string[]
  allowedSubsidiaryIds?: string[] | null
  targetTable?: string
  targetRows: unknown[]
  detachResult?: RouteState['detachResult']
}): void {
  routeState.permissions = new Set(input.permissions)
  routeState.allowedSubsidiaryIds = input.allowedSubsidiaryIds == null ? null : new Set(input.allowedSubsidiaryIds)
  routeState.link = { id: attachmentId, fileId, targetTable: input.targetTable ?? 'documents', targetId }
  routeState.targetRows = [...input.targetRows]
  routeState.detachResult = input.detachResult ?? { ok: true }
  routeState.detachCalls = []
  routeState.permissionChecks.length = 0
}

function del(id = attachmentId): Promise<Response> {
  return DELETE(new Request(`http://openbooks.test/api/file-cabinet/attachments/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  })
}

test('DELETE hides an out-of-scope target exactly like a missing attachment', async () => {
  reset({
    permissions: ['documents.manage', 'ap.read'],
    allowedSubsidiaryIds: ['00000000-0000-4000-8000-000000000099'],
    targetRows: [[{ kind: 'vendor_bill', subsidiaryId: '00000000-0000-4000-8000-000000000098' }]],
  })

  const response = await del()

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.deepEqual(routeState.detachCalls, [], 'nothing is detached from a hidden record')
})

test('DELETE requires the owning record permission, not just cabinet management', async () => {
  reset({
    permissions: ['documents.manage'],
    targetRows: [[{ kind: 'pay_run', subsidiaryId: null }]],
  })

  const response = await del()

  assert.equal(response.status, 403)
  assert.ok(routeState.permissionChecks.includes('payroll.read'), 'the pay-run family permission is consulted')
  assert.deepEqual(routeState.detachCalls, [])
})

test('DELETE keeps the file-mutation gate for the target family', async () => {
  reset({
    permissions: ['ar.read'],
    targetRows: [[{ kind: 'customer_invoice', subsidiaryId: null }]],
  })

  const response = await del()

  assert.equal(response.status, 403)
  assert.deepEqual(routeState.detachCalls, [])
})

test('DELETE surfaces the retention refusal of a posted or active record as a conflict', async () => {
  reset({
    permissions: ['ap.create', 'ap.read'],
    targetRows: [[{ kind: 'vendor_bill', subsidiaryId: null }]],
    detachResult: { ok: false, reason: 'retained' },
  })

  const response = await del()

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'attachments of posted or active records are retained' })
  assert.equal(routeState.detachCalls.length, 1)
})

test('DELETE detaches an in-scope, permitted attachment with actor attribution', async () => {
  reset({
    permissions: ['ap.create', 'ap.read'],
    allowedSubsidiaryIds: ['00000000-0000-4000-8000-000000000099'],
    targetRows: [[{ kind: 'vendor_bill', subsidiaryId: '00000000-0000-4000-8000-000000000099' }]],
  })

  const response = await del()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(routeState.detachCalls, [['org-1', attachmentId, { actorId: 'user-1' }]])
})

test('DELETE refuses a malformed id before any lookup', async () => {
  reset({ permissions: ['*'], targetRows: [] })

  const response = await del('not-a-uuid')

  assert.equal(response.status, 404)
  assert.deepEqual(routeState.detachCalls, [])
})
