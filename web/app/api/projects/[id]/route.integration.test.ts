import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.project-detail-route-test')
type Scope = Set<string> | null
interface RouteState {
  authz: {
    user: { orgId: string; id: string }
    allowedSubsidiaryIds: Scope
  }
  payload: { project: Record<string, unknown> }
  existing: { name: string; is_active: boolean; custom: Record<string, unknown>; subsidiary_id: string | null }
  locked: { subsidiary_id: string | null } | null
  executeCalls: number
  writes: number
}

const routeState: RouteState = {
  authz: {
    user: { orgId: 'org-1', id: 'user-1' },
    allowedSubsidiaryIds: new Set(['sub-allowed']),
  },
  payload: { project: { id: 'project-1', subsidiary_id: 'sub-allowed' } },
  existing: { name: 'Project', is_active: true, custom: {}, subsidiary_id: 'sub-allowed' },
  locked: { subsidiary_id: 'sub-allowed' },
  executeCalls: 0,
  writes: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.project-detail-route-test')]
      export async function guardPermission() { return state.authz }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (authz.allowedSubsidiaryIds === null) return null
        if (subsidiaryId !== null && subsidiaryId !== undefined && authz.allowedSubsidiaryIds.has(String(subsidiaryId))) return null
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      export function subsidiariesInScope(authz, ids) {
        return authz.allowedSubsidiaryIds === null || ids.every((id) => id !== null && id !== undefined && authz.allowedSubsidiaryIds.has(id))
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.project-detail-route-test')]
      export const db = {
        execute: async (query) => {
          state.executeCalls += 1
          const chunks = query?.queryChunks ?? []
          const text = chunks.map((chunk) => {
            if (typeof chunk === 'string') return chunk
            if (Array.isArray(chunk?.value)) return chunk.value.map(String).join('')
            return ''
          }).join('')
          if (text.includes('update projects set')) {
            state.writes += 1
            return { rows: [] }
          }
          if (text.includes('for update')) return { rows: state.locked ? [state.locked] : [] }
          return { rows: [state.existing] }
        },
      }
      export function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(req) {
        return { ok: true, data: await req.json() }
      }
    `,
  ],
  [
    'mock:project-loader',
    `
      const state = globalThis[Symbol.for('openbooks.project-detail-route-test')]
      export async function loadProject() { return state.payload }
    `,
  ],
  [
    'mock:custom-fields',
    `
      export async function loadFieldDefs() { return [] }
      export function validateCustomValues() { return { ok: true, cleaned: {} } }
    `,
  ],
  [
    'mock:money',
    `
      export function normalizeMoney(value) { return String(value) }
    `,
  ],
  [
    'mock:decimal',
    `
      export function canonicalDecimal(value) { return String(value) }
    `,
  ],
  [
    'mock:projects-gate',
    `
      export async function guardProjectsFeature() { return null }
    `,
  ],
  [
    'mock:features',
    `
      export async function isFeatureEnabled() { return true }
      export async function acquireFeatureGateLock() {}
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/custom-fields', 'mock:custom-fields'],
  ['../../../../lib/exact-decimal', 'mock:decimal'],
  ['../../../../lib/features', 'mock:features'],
  ['../../../../lib/projects-gate', 'mock:projects-gate'],
  ['../_lib', 'mock:project-loader'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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

const { GET, PATCH } = (await import('./route.ts?project-detail-scope-test')) as typeof import('./route.ts')
hooks.deregister()

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'

function reset(): void {
  routeState.authz.allowedSubsidiaryIds = new Set(['sub-allowed'])
  routeState.payload = { project: { id: PROJECT_ID, subsidiary_id: 'sub-allowed' } }
  routeState.existing = { name: 'Project', is_active: true, custom: {}, subsidiary_id: 'sub-allowed' }
  routeState.locked = { subsidiary_id: 'sub-allowed' }
  routeState.executeCalls = 0
  routeState.writes = 0
}

function params() {
  return { params: Promise.resolve({ id: PROJECT_ID }) }
}

function patchRequest(body: unknown): Request {
  return new Request(`http://openbooks.test/api/projects/${PROJECT_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET hides a project outside the caller subsidiary scope', async () => {
  reset()
  routeState.payload = { project: { id: PROJECT_ID, subsidiary_id: 'sub-other' } }

  const response = await GET(new Request('http://openbooks.test'), params())

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
})

test('PATCH rejects moving a project into an out-of-scope subsidiary without writing', async () => {
  reset()

  const response = await PATCH(patchRequest({ subsidiaryId: '00000000-0000-4000-8000-000000000002' }), params())

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'Subsidiary not found' })
  assert.equal(routeState.writes, 0)
})

test('PATCH updates a project that is inside the caller subsidiary scope', async () => {
  reset()

  const response = await PATCH(patchRequest({ name: 'Renamed project' }), params())

  assert.equal(response.status, 200)
  assert.equal(routeState.writes, 1)
})
