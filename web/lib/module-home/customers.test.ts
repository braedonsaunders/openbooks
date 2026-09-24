import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The home tile reads the ONE org DSO from the cash engine, so this contract
// pins the handoff — the caller's exact subsidiary scope and org reach the
// engine reader untouched — rather than any local SQL. The engine's own SQL
// scoping is covered by the cash-payment-scope battery.
const callsKey = Symbol.for('openbooks.customers-home-dso-calls')
type DsoCall = { side: string; asOf: string; subIds: string[] | undefined; orgId: string | undefined }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[callsKey] = [] as DsoCall[]
const mocks = new Map([
  ['server-only', 'export {}'],
  ['@openbooks/engine/src/platform/db.ts', `
    export const db = { execute: async () => {
      // One canned row satisfies the org-currency lookup every dashboard
      // call ends with.
      return { rows: [{ baseCurrency: 'CAD' }] }
    } }
  `],
  ['@openbooks/engine/src/platform/business-date.ts', `
    export async function businessToday() { return '2026-08-28' }
    export function addCalendarDays() { return '2026-08-21' }
    export function weekStartsEndingOn() { return ['2026-08-24'] }
    export function calendarQuarterBounds() { return { start: '2026-07-01', end: '2026-09-30' } }
  `],
  ['../features', 'export async function isFeatureEnabled() { return false }'],
  ['../crm', 'export async function calculateForecast() { return [] }'],
  ['../crm-scope', "export function crmOpportunityScope() { throw new Error('CRM is disabled') }"],
  ['../cash/core', `
    export async function paymentStats(side, asOf, subIds, orgId) {
      globalThis[Symbol.for('openbooks.customers-home-dso-calls')].push({ side, asOf, subIds, orgId })
      return { map: new Map(), globalAvg: 45 }
    }
  `],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = mocks.get(specifier)
    if (mock !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mock)}` }
    return nextResolve(specifier, context)
  },
})
const customersUrl = './customers.ts?scope-contract'
const { customersHome } = await import(customersUrl) as typeof import('./customers.ts')
hooks.deregister()

const subsidiaryA = '00000000-0000-0000-0000-000000000001'
const subsidiaryB = '00000000-0000-0000-0000-000000000002'
const orgId = '00000000-0000-0000-0000-000000000003'

function dsoCalls() {
  return (globalThis as typeof globalThis & Record<symbol, unknown>)[callsKey] as DsoCall[]
}

async function dsoHandoff(subIds?: string[]) {
  dsoCalls().length = 0
  const home = await customersHome(orgId, subIds)
  assert.equal(home.dso, 45, 'tile surfaces the engine DSO value untouched')
  assert.equal(dsoCalls().length, 1, 'tile reads DSO from the engine exactly once')
  return dsoCalls()[0]!
}

for (const [name, ids] of [
  ['one subsidiary', [subsidiaryA]],
  ['multiple subsidiaries', [subsidiaryA, subsidiaryB]],
  ['empty scope', []],
] as const) {
  test(`customer DSO hands the ${name} scope to the engine reader`, async () => {
    const call = await dsoHandoff([...ids])
    assert.equal(call.side, 'ar')
    assert.equal(call.asOf, '2026-08-28')
    assert.deepEqual(call.subIds, [...ids])
    assert.equal(call.orgId, orgId)
  })
}

test('unrestricted customer DSO reads the company rollup', async () => {
  const call = await dsoHandoff()
  assert.equal(call.side, 'ar')
  assert.equal(call.subIds, undefined, 'undefined scope must reach the rollup path, never widen to []')
  assert.equal(call.orgId, orgId)
})
