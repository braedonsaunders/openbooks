import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface RouteState {
  mode: 'committed' | 'pre-commit' | 'success'
  createCalls: number
}

const stateKey = Symbol.for('openbooks.project-charge-route-test')
const routeState: RouteState = { mode: 'committed', createCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      export const db = {
        async execute(query) {
          const chunks = query?.queryChunks
          const text = Array.isArray(chunks)
            ? chunks.map((chunk) => Array.isArray(chunk?.value) ? chunk.value.map(String).join('') : '').join('')
            : ''
          return text.includes('select subsidiary_id') ? { rows: [{ subsidiary_id: null }] } : { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:features',
    `export async function isFeatureEnabled() { return true }`,
  ],
  [
    'mock:projects-gate',
    `export async function guardProjectsFeature() { return null }`,
  ],
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
    'mock:project-charges',
    `
      const state = globalThis[Symbol.for('openbooks.project-charge-route-test')]
      export class ChargeError extends Error {}
      export class ChargeCommittedError extends Error {
        constructor(chargeId, documentNumber, stage, cause) {
          super('project charge ' + documentNumber + ' (' + chargeId + ') was committed but ' + stage + ' failed: ' + cause.message)
          this.chargeId = chargeId
          this.documentNumber = documentNumber
          this.stage = stage
          this.cause = cause
        }
      }
      export async function createProjectCharge() {
        state.createCalls += 1
        if (state.mode === 'pre-commit') throw new ChargeError('item not found')
        if (state.mode === 'committed') {
          throw new ChargeCommittedError(
            '00000000-0000-4000-8000-00000000c001',
            'CHG-0001',
            'posting',
            new Error('no accounting period covers 2026-08-28'),
          )
        }
        return { id: '00000000-0000-4000-8000-00000000c002', documentNumber: 'CHG-0002', approvalPending: false }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../lib/features', 'mock:features'],
  ['../../../lib/projects-gate', 'mock:projects-gate'],
  ['../../../lib/project-charges', 'mock:project-charges'],
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

const routeUrl = './route.ts?project-charge-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const body = {
  projectId: '00000000-0000-4000-8000-00000000a001',
  lines: [{ itemId: '00000000-0000-4000-8000-00000000a001', quantity: '1', costRate: '1', billRate: '1' }],
}

function reset(mode: RouteState['mode']): void {
  routeState.mode = mode
  routeState.createCalls = 0
}

function post(): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/project-charges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('POST exposes the committed charge identity and lifecycle failure stage', async () => {
  reset('committed')
  const response = await post()

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'project charge CHG-0001 (00000000-0000-4000-8000-00000000c001) was committed but posting failed: no accounting period covers 2026-08-28',
    committed: true,
    chargeId: '00000000-0000-4000-8000-00000000c001',
    documentNumber: 'CHG-0001',
    stage: 'posting',
    cause: 'no accounting period covers 2026-08-28',
  })
  assert.equal(routeState.createCalls, 1)
})

test('POST keeps pre-commit validation errors as ordinary 422 failures', async () => {
  reset('pre-commit')
  const response = await post()

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'item not found' })
  assert.equal(routeState.createCalls, 1)
})

test('POST preserves the successful create response', async () => {
  reset('success')
  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: '00000000-0000-4000-8000-00000000c002',
    documentNumber: 'CHG-0002',
    approvalPending: false,
  })
  assert.equal(routeState.createCalls, 1)
})
