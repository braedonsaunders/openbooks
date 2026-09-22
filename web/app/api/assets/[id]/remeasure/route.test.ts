import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'

interface RemeasurementCall {
  orgId: string
  assetId: string
  options: Record<string, unknown>
}

interface RouteState {
  isIsoCalendarDate: typeof isIsoCalendarDate
  businessTodayCalls: string[]
  remeasureCalls: RemeasurementCall[]
}

const stateKey = Symbol.for('openbooks.asset-remeasurement-route-test')
const routeState: RouteState = {
  isIsoCalendarDate,
  businessTodayCalls: [],
  remeasureCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    'mock:business-date',
    `
      const state = globalThis[Symbol.for('openbooks.asset-remeasurement-route-test')]
      export async function businessToday(orgId) {
        state.businessTodayCalls.push(orgId)
        return '2026-08-31'
      }
      export const isIsoCalendarDate = state.isIsoCalendarDate
    `,
  ],
  [
    'mock:asset-lifecycle',
    `
      const state = globalThis[Symbol.for('openbooks.asset-remeasurement-route-test')]
      export async function remeasureAsset(orgId, assetId, options) {
        state.remeasureCalls.push({ orgId, assetId, options })
        return { remeasured: true }
      }
    `,
  ],
])

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles cannot produce the refusals the real modules enforce.
const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['@openbooks/engine/src/assets/asset-lifecycle.ts', 'mock:asset-lifecycle'],
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

const routeUrl = './route.ts?asset-remeasurement-date-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const ASSET_ID = '00000000-0000-4000-8000-00000000a001'

function reset(): void {
  routeState.businessTodayCalls.length = 0
  routeState.remeasureCalls.length = 0
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/assets/${ASSET_ID}/remeasure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newCarryingValue: '800', ...(body as Record<string, unknown>) }),
    }),
    { params: Promise.resolve({ id: ASSET_ID }) },
  )
}

test('an omitted remeasurement date alone defaults to the organization business day', async () => {
  reset()

  const response = await post({})

  assert.equal(response.status, 200)
  assert.deepEqual(routeState.businessTodayCalls, ['org-1'])
  assert.deepEqual(routeState.remeasureCalls, [
    {
      orgId: 'org-1',
      assetId: ASSET_ID,
      options: {
newCarryingValue: '800.0000',
        date: '2026-08-31',
        actorId: 'user-1',
      },
    },
  ])
})

test('invalid remeasurement dates return 422 before reaching the remeasurement engine', async () => {
  const cases: Array<{ label: string; date: unknown }> = [
    { label: 'empty', date: '' },
    { label: 'non-string', date: 20260831 },
    { label: 'malformed format', date: '31-08-2026' },
    { label: 'impossible calendar date', date: '2026-02-30' },
  ]

  for (const { label, date } of cases) {
    reset()

    const response = await post({ date })

    assert.equal(response.status, 422, label)
    assert.deepEqual(routeState.businessTodayCalls, [], `${label} date must not default`)
    assert.deepEqual(routeState.remeasureCalls, [], `${label} date must not reach remeasureAsset`)
  }
})
