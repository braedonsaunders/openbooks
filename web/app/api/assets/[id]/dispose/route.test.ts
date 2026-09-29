import assert from 'node:assert/strict'
import { stubModules } from '../../../../../testing/stub-modules'
import test from 'node:test'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'

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

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles cannot produce the refusals the real modules enforce.

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/feature-gates": `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
    "@/lib/feature-gates": `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
    "@openbooks/engine/src/platform/business-date.ts": `
      const state = globalThis[Symbol.for('openbooks.asset-disposal-route-test')]
      export async function businessToday(orgId) {
        state.businessTodayCalls.push(orgId)
        return '2026-08-31'
      }
      export const isIsoCalendarDate = state.isIsoCalendarDate
    `,
    "@openbooks/engine/src/assets/asset-lifecycle.ts": `
      const state = globalThis[Symbol.for('openbooks.asset-disposal-route-test')]
      export async function disposeAsset(orgId, assetId, options) {
        state.disposeCalls.push({ orgId, assetId, options })
        return { disposed: true }
      }
    `,
  },
})

const routeUrl = './route.ts?asset-disposal-date-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')

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
        proceeds: '0.0000',
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
