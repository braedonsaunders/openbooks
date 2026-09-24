import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * PATCH payroll/anomalies/[id] — the flag id binds a uuid column inside
 * resolveFlag. A 36-character hex/dash string is not a UUID, so the route
 * must refuse it as a 400 shape refusal before resolveFlag runs — never as
 * a database cast error. The guard itself is the shared list-params isUuid
 * (imported for real); only authz, feature flags, and resolveFlag are
 * doubled, and resolveFlag counts its calls so the tests prove it never ran.
 */
const stateKey = Symbol.for('openbooks.payroll-anomalies-id-test')
interface RouteState { resolveCalls: number }
const state: RouteState = { resolveCalls: 0 }
;(globalThis as Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:ai-rails',
    `
      export async function requireAnyPerm() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
      export function aiRailsErrorResponse() {
        return Response.json({ error: 'rails' }, { status: 500 })
      }
    `,
  ],
  [
    'mock:features',
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
  [
    'mock:anomalies',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-anomalies-id-test')]
      export async function resolveFlag(input) {
        state.resolveCalls += 1
        return { id: input.flagId, to: input.to }
      }
    `,
  ],
  // Loader boundary, not behaviour: the body parser marks itself server-only,
  // which the plain node loader refuses. An empty module satisfies the
  // side-effect import; every behavioural import stays real.
  ['mock:server-only', 'export default {}'],
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/ai-rails', 'mock:ai-rails'],
  ['../../../../../lib/features', 'mock:features'],
  ['@openbooks/engine/src/hrm/ai/anomalies.ts', 'mock:anomalies'],
  ['server-only', 'mock:server-only'],
])

// The route imports the body parser through the `@/` alias, which the plain
// node loader does not resolve: redirect that ONE specifier at the real pure
// module (never a double of it) so the test exercises the real parse.
const testDir = dirname(fileURLToPath(import.meta.url))
const realJsonUrl = pathToFileURL(join(testDir, '../../../../../lib/api/json.ts')).href

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/api/json') return { url: realJsonUrl, shortCircuit: true }
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

const routeUrl = './route.ts?payroll-anomalies-id-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function patch(id: string): Promise<Response> {
  return PATCH(
    new Request('http://openbooks.test/api/payroll/anomalies/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'acknowledged', reason: 'reviewed' }),
    }),
    { params: Promise.resolve({ id }) },
  )
}

test('a 36-dash flag id is refused before resolveFlag runs', async () => {
  state.resolveCalls = 0
  const response = await patch('-'.repeat(36))
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await response.json() as { error: string }).error, /must be a uuid/)
  assert.equal(state.resolveCalls, 0)
})

test('ungrouped 36-character hex is refused the same way', async () => {
  const id = '000000000000400080000000000000010000'
  assert.equal(id.length, 36)
  state.resolveCalls = 0
  const response = await patch(id)
  assert.equal(response.status, 400, await response.clone().text())
  assert.equal(state.resolveCalls, 0)
})

test('a real uuid reaches resolveFlag', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  state.resolveCalls = 0
  const response = await patch(id)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(state.resolveCalls, 1)
  assert.equal((await response.json() as { flag: { id: string } }).flag.id, id)
})
