import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'

interface DisposalCall {
  orgId: string
  assetId: string
  options: Record<string, unknown>
}

interface RouteState {
  isIsoCalendarDate: typeof isIsoCalendarDate
  businessTodayCalls: string[]
  disposeCalls: DisposalCall[]
}

const stateKey = Symbol.for('openbooks.asset-disposal-route-test')
const routeState: RouteState = {
  isIsoCalendarDate,
  businessTodayCalls: [],
  disposeCalls: [],
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
    'mock:exact-decimal',
    `
      export function canonicalDecimal(value) {
        return value == null ? null : String(value)
      }
      export function compareDecimal(left, right) {
        return Number(left) < Number(right) ? -1 : Number(left) > Number(right) ? 1 : 0
      }
    `,
  ],
  [
    'mock:money',
    `
      export function normalizeMoney(value) { return String(value) }
    `,
  ],
  [
    'mock:business-date',
    `
      const state = globalThis[Symbol.for('openbooks.asset-disposal-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.asset-disposal-route-test')]
      export async function disposeAsset(orgId, assetId, options) {
        state.disposeCalls.push({ orgId, assetId, options })
        return { disposed: true }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../lib/exact-decimal', 'mock:exact-decimal'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
  ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
  ['@openbooks/engine/src/asset-lifecycle.ts', 'mock:asset-lifecycle'],
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

const routeUrl = './route.ts?asset-disposal-date-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const ASSET_ID = '00000000-0000-4000-8000-00000000a001'

function reset(): void {
  routeState.businessTodayCalls.length = 0
  routeState.disposeCalls.length = 0
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/assets/${ASSET_ID}/dispose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ASSET_ID }) },
  )
}

test('an omitted disposal date alone defaults to the organization business day', async () => {
  reset()

  const response = await post({})

  assert.equal(response.status, 200)
  assert.deepEqual(routeState.businessTodayCalls, ['org-1'])
  assert.deepEqual(routeState.disposeCalls, [
    {
      orgId: 'org-1',
      assetId: ASSET_ID,
      options: {
        proceeds: '0',
        proceedsAccountId: null,
        date: '2026-08-31',
        actorId: 'user-1',
        writeOff: false,
      },
    },
  ])
})

test('invalid disposal dates return 422 before reaching the disposal engine', async () => {
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
    assert.deepEqual(routeState.disposeCalls, [], `${label} date must not reach disposeAsset`)
  }
})
