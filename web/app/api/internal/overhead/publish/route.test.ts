import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Boundary suite for the worker-to-web overhead publish seam. The route is
// public and CSRF-exempt, so the shared internal token is its only control:
// the comparison must be constant-time and fail closed, and the org id must
// be validated BEFORE any org-scoped work (feature gate, RLS scope) runs.
const stateKey = Symbol.for('openbooks.internal-overhead-publish-test')
interface RouteState {
  gateCalls: unknown[]
  publishCalls: unknown[][]
  failKind: 'refusal' | 'unexpected' | null
}
const state: RouteState = { gateCalls: [], publishCalls: [], failKind: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const ORG_ID = '00000000-0000-4000-8000-00000000c001'

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
    'mock:overhead-publish',
    `
      const state = globalThis[Symbol.for('openbooks.internal-overhead-publish-test')]
      export class OverheadPublishError extends Error {}
      export async function publishOverheadRates(...args) {
        state.publishCalls.push(args)
        if (state.failKind === 'refusal') throw new OverheadPublishError('overhead auto-publish blocked: department X has no method')
        if (state.failKind === 'unexpected') throw new Error('relation "openbooks_secret_table" does not exist')
        return { published: 1 }
      }
    `,
  ],
  [
    'mock:projects-gate',
    `
      const state = globalThis[Symbol.for('openbooks.internal-overhead-publish-test')]
      export async function guardProjectsFeature(orgId) {
        state.gateCalls.push(orgId)
        return null
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/overhead-publish', 'mock:overhead-publish'],
  ['../../../../../lib/projects-gate', 'mock:projects-gate'],
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

const routeUrl = './route.ts?internal-overhead-publish-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(token: string | undefined): void {
  state.gateCalls = []
  state.publishCalls = []
  state.failKind = null
  if (token === undefined) delete process.env.OPENBOOKS_INTERNAL_TOKEN
  else process.env.OPENBOOKS_INTERNAL_TOKEN = token
}

function post(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['x-internal-token'] = token
  return POST(
    new Request('http://openbooks.test/api/internal/overhead/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

test('an unconfigured server refuses every caller, even one sending an empty token', async () => {
  reset(undefined)
  const response = await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' }, '')
  assert.equal(response.status, 401)
  assert.equal(state.gateCalls.length, 0)
  assert.equal(state.publishCalls.length, 0)
})

test('a wrong or missing token is refused before the body is read', async () => {
  reset('worker-secret')
  assert.equal((await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' }, 'worker-secreT')).status, 401)
  assert.equal((await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' })).status, 401)
  assert.equal((await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' }, 'worker')).status, 401)
  assert.equal(state.gateCalls.length, 0)
  assert.equal(state.publishCalls.length, 0)
})

test('a non-uuid orgId is rejected before any org-scoped work runs', async () => {
  reset('worker-secret')
  for (const orgId of ['not-a-uuid', '', 42, null, { id: ORG_ID }, `${ORG_ID}'; drop table x;--`]) {
    const response = await post({ orgId, effectiveFrom: '2026-09-01' }, 'worker-secret')
    assert.equal(response.status, 422, `orgId ${JSON.stringify(orgId)} must be refused`)
  }
  assert.deepEqual(state.gateCalls, [], 'the feature gate never saw an unvalidated org id')
  assert.deepEqual(state.publishCalls, [], 'nothing was published')
})

test('a malformed effectiveFrom is still rejected with 422', async () => {
  reset('worker-secret')
  const response = await post({ orgId: ORG_ID, effectiveFrom: '2026/09/01' }, 'worker-secret')
  assert.equal(response.status, 422)
  assert.equal(state.publishCalls.length, 0)
})

test('a valid call publishes for the canonical org id', async () => {
  reset('worker-secret')
  const response = await post({ orgId: ORG_ID.toUpperCase(), effectiveFrom: '2026-09-01' }, 'worker-secret')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, published: 1 })
  assert.deepEqual(state.gateCalls, [ORG_ID])
  assert.deepEqual(state.publishCalls, [[ORG_ID, null, '2026-09-01']])
})

test('a domain refusal is a 409 naming the blocker, not a leaked 500', async () => {
  reset('worker-secret')
  state.failKind = 'refusal'
  const response = await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' }, 'worker-secret')
  assert.equal(response.status, 409)
  assert.match(((await response.json()) as { error: string }).error, /blocked: department X has no method/)
})

test('an unexpected fault is a generic 500 that discloses nothing', async () => {
  reset('worker-secret')
  state.failKind = 'unexpected'
  const response = await post({ orgId: ORG_ID, effectiveFrom: '2026-09-01' }, 'worker-secret')
  assert.equal(response.status, 500)
  const body = (await response.json()) as { error: string }
  assert.doesNotMatch(body.error, /openbooks_secret_table/)
})
