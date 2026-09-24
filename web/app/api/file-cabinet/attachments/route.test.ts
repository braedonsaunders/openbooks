import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.file-cabinet-attachments-route-test')
const targetId = '00000000-0000-4000-8000-000000000001'
const visibleFileId = '00000000-0000-4000-8000-000000000002'
const hiddenFileId = '00000000-0000-4000-8000-000000000003'

interface RouteState {
  permissions: Set<string>
  allowedSubsidiaryIds: Set<string> | null
  targetRows: unknown[]
  attachments: Array<{ id: string; name: string }>
  fileVisibility: Map<string, { isInactive?: boolean } | null>
  permissionChecks: string[]
  listCalls: number
}

const routeState: RouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  targetRows: [],
  attachments: [],
  fileVisibility: new Map(),
  permissionChecks: [],
  listCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachments-route-test')]
      export const db = {
        execute() { return Promise.resolve({ rows: state.targetRows.shift() ?? [] }) },
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachments-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.file-cabinet-attachments-route-test')]
      export async function listAttachments() {
        state.listCalls += 1
        return state.attachments
      }
      export async function getFile(_orgId, id) {
        return state.fileVisibility.get(id) ?? null
      }
      export function accessAtLeast() { return true }
      export async function fileAccessLevel() { return 'viewer' }
      export async function folderAccessLevel() { return 'viewer' }
      export async function attachExisting() { return 'attachment-1' }
      export async function uploadAndAttach() { return { id: 'file-1' } }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../../lib/file-cabinet', 'mock:file-cabinet'],
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

const { GET, POST } = (await import('./route.ts')) as typeof import('./route.ts')
hooks.deregister()

function reset(input: {
  permissions: string[]
  allowedSubsidiaryIds?: string[] | null
  targetRows: unknown[]
  attachments?: Array<{ id: string; name: string }>
  fileVisibility?: Map<string, { isInactive?: boolean } | null>
}): void {
  routeState.permissions = new Set(input.permissions)
  routeState.allowedSubsidiaryIds = input.allowedSubsidiaryIds === null || input.allowedSubsidiaryIds === undefined ? null : new Set(input.allowedSubsidiaryIds)
  routeState.targetRows = [...input.targetRows]
  routeState.attachments = input.attachments ?? []
  routeState.fileVisibility = input.fileVisibility ?? new Map()
  routeState.permissionChecks.length = 0
  routeState.listCalls = 0
}

function get(targetTable: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/file-cabinet/attachments?targetTable=${targetTable}&targetId=${targetId}`))
}

test('GET uses the owning resource permission instead of documents.read', async () => {
  reset({ permissions: ['documents.read'], targetRows: [[{ partySubsidiaryId: null, projectSubsidiaryId: null }]] })

  const response = await get('compliance_records')

  assert.deepEqual([response.status, routeState.permissionChecks, routeState.listCalls], [403, ['compliance.read'], 0])
})

test('GET hides out-of-scope targets before listing their attachments', async () => {
  reset({
    permissions: ['compliance.read'],
    allowedSubsidiaryIds: ['00000000-0000-4000-8000-000000000099'],
    targetRows: [
      [
        {
          partySubsidiaryId: null,
          projectSubsidiaryId: '00000000-0000-4000-8000-000000000098',
        },
      ],
    ],
  })

  const response = await get('compliance_records')

  assert.deepEqual([response.status, routeState.listCalls], [404, 0])
})

test('GET keeps org-wide rate-card targets visible to restricted setup users', async () => {
  reset({
    permissions: ['admin.setup.manage'],
    allowedSubsidiaryIds: ['00000000-0000-4000-8000-000000000099'],
    targetRows: [[{}]],
  })

  const response = await get('item_rate_versions')

  assert.deepEqual([response.status, routeState.listCalls], [200, 1])
})

test('GET filters attachment metadata through file visibility', async () => {
  reset({
    permissions: ['compliance.read'],
    allowedSubsidiaryIds: ['00000000-0000-4000-8000-000000000099'],
    targetRows: [
      [
        {
          partySubsidiaryId: null,
          projectSubsidiaryId: '00000000-0000-4000-8000-000000000099',
        },
      ],
    ],
    attachments: [
      { id: visibleFileId, name: 'visible.pdf' },
      { id: hiddenFileId, name: 'private.pdf' },
    ],
    fileVisibility: new Map([
      [visibleFileId, { isInactive: false }],
      [hiddenFileId, null],
    ]),
  })

  const response = await get('compliance_records')

  assert.deepEqual([response.status, await response.json()], [200, { attachments: [{ id: visibleFileId, name: 'visible.pdf' }] }])
})

test('POST requires the write permission for the target document kind', async () => {
  reset({ permissions: ['ar.create'], targetRows: [[{ kind: 'vendor_bill', subsidiaryId: null }]] })

  const response = await POST(new Request('http://openbooks.test/api/file-cabinet/attachments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: visibleFileId, targetTable: 'documents', targetId }) }))

  assert.deepEqual([response.status, routeState.permissionChecks], [403, ['documents.manage', 'ap.create']])
})
