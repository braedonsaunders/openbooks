import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Statutory rate rows are effective-dated payroll inputs: the engine no longer
 * deletes one — DELETE retires the open row (stamps superseded_on, writes no
 * successor), so prior periods keep resolving while the current setup reads
 * unconfigured. The setup surface renders a Supersede button for every stored
 * row, so that path is on the operator's main flow.
 *
 * History: the engine used to REFUSE every delete ("save a replacement rate
 * for the tax year instead"), and the refusal reached the operator as a 500
 * because the DELETE handler had no catch while the PUT handler one function
 * above did. The UI then called `res.json()` on a non-JSON error body, so the
 * toast showed a JSON parse error rather than the remedy. Both halves are
 * fixed — the handler catches PayrollError as a 422 like every other payroll
 * route, and the client checks status before parsing — and these tests pin
 * the status contract, not the prose.
 *
 * The mock error classes mirror the PRODUCTION hierarchy
 * (PayrollJurisdictionError -> PayrollPackError -> PayrollError). If they were
 * three unrelated `extends Error` classes the handler's `instanceof PayrollError`
 * would miss them and these tests would pass while production still 500'd.
 */

interface RouteState {
  deleteAttempts: string[]
  deleteResult: 'retired' | 'missing'
}

const stateKey = Symbol.for('openbooks.payroll-rates-route-test')
const state: RouteState = { deleteAttempts: [], deleteResult: 'retired' }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardRootSubsidiaryScope() { return null }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    'mock:payroll-error',
    `
      export class PayrollError extends Error {}
    `,
  ],
  [
    // The real packs module re-exports the pack hierarchy rooted at
    // PayrollError, so the mock imports the mocked root and extends it.
    'mock:packs',
    `
      import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
      export class PayrollPackError extends PayrollError {}
      export class PayrollJurisdictionError extends PayrollPackError {}
      export function payrollPack(country) {
        if (country !== 'CA') {
          throw new PayrollJurisdictionError(
            'no payroll country pack for ' + (country || '(unset)') + ' — payroll is implemented for CA, US',
          )
        }
        return { regions: { label: 'province', known: ['ON'] }, statutoryRates: { slots: [] } }
      }
      export function packRates() { return { slots: [] } }
      export function statutoryRateSlot() { return null }
      export function payrollTaxYearCoverage() { return [] }
      export function payrollTaxYearForDate() { return { taxYear: 2026 } }
    `,
  ],
  [
    'mock:statutory-rates',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-rates-route-test')]
      const { PayrollPackError } = await import('@openbooks/engine/src/payroll/packs.ts')
      export async function deleteStatutoryRate(orgId, actorId, id) {
        state.deleteAttempts.push(id)
        if (state.deleteResult === 'missing') return false
        return true
      }
      export async function listStatutoryRates() { return [] }
      export function statutoryRateProblem() { return null }
      export async function upsertStatutoryRate() { return { id: 'rate-1', values: {} } }
    `,
  ],
  [
    'mock:db',
    `
      export const db = { execute: async () => ({ rows: [] }) }
    `,
  ],
  [
    'mock:drizzle',
    `
      export function sql() { return {} }
    `,
  ],
  [
    'mock:filing',
    `
      export async function listFilingAccounts() { return [] }
    `,
  ],
  [
    'mock:readiness',
    `
      export async function installedPayrollCountries() { return ['CA'] }
      export async function payrollStatutoryRateGaps() { return [] }
    `,
  ],
  [
    'mock:business-date',
    `
      export function businessToday() { return '2026-09-19' }
    `,
  ],
])

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: the statutory-rate refusals this file pins are exactly the kind a
// hand double cannot produce (a passthrough canonicalDecimal accepts every
// amount, so no over-precision refusal could ever fire here).
const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['@openbooks/engine/src/payroll/error.ts', 'mock:payroll-error'],
  ['@openbooks/engine/src/payroll/packs.ts', 'mock:packs'],
  ['@openbooks/engine/src/payroll/statutory-rates.ts', 'mock:statutory-rates'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/payroll/filing.ts', 'mock:filing'],
  ['@openbooks/engine/src/payroll/readiness.ts', 'mock:readiness'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real '@/lib/api/json' imports 'server-only', which is inert here.
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
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

const routeUrl = './route.ts?payroll-statutory-rates-refusal-test'
const { DELETE, PUT } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const ROW_ID = '11111111-2222-4333-8444-555555555555'

function del(id: string): Promise<Response> {
  return DELETE(new Request(`http://openbooks.test/api/payroll/settings/rates?id=${id}`, {
    method: 'DELETE',
  }))
}

test('retiring a statutory rate row succeeds with a 200, not the old refusal', async () => {
  state.deleteAttempts.length = 0
  state.deleteResult = 'retired'

  const response = await del(ROW_ID)

  // The old contract refused every existing row with a 422; Remove is now a
  // supersession, so the engine retires the row and the route reports success.
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  // And the engine was genuinely reached, so this is the real retire path
  // rather than an early validation return that happens to share the status.
  assert.deepEqual(state.deleteAttempts, [ROW_ID])
})

test('the response body is JSON, because the client reads the error out of it', async () => {
  state.deleteAttempts.length = 0
  state.deleteResult = 'missing'

  const response = await del(ROW_ID)

  // StatutoryRatesSection.remove() used to do `await res.json()` BEFORE
  // checking res.ok, so a non-JSON error body threw a SyntaxError and the
  // toast showed a parse error instead of the message. Parsing must not
  // throw, on success or on failure.
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  await assert.doesNotReject(async () => { await response.json() })
})

test('a row that does not exist is still a 404, not a success', async () => {
  state.deleteAttempts.length = 0
  state.deleteResult = 'missing'

  const response = await del(ROW_ID)

  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'not found')
})

test('a malformed id is refused before the engine is reached', async () => {
  state.deleteAttempts.length = 0
  state.deleteResult = 'retired'

  const response = await del('not-a-uuid')

  assert.equal(response.status, 422)
  assert.equal((await response.json()).error, 'invalid id')
  assert.deepEqual(state.deleteAttempts, [])
})

test('an unknown country on PUT is a 422 naming the implemented countries', async () => {
  // `country` is any non-empty string off the request body, so payrollPack()
  // throws PayrollJurisdictionError for an unknown one. That call sits before
  // the handler's own try block, so uncaught it was a 500.
  const response = await PUT(new Request('http://openbooks.test/api/payroll/settings/rates', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ country: 'XX', rateKey: 'eht', taxYear: 2026, values: {} }),
  }))

  assert.equal(response.status, 422)
  assert.match((await response.json()).error, /no payroll country pack for XX/)
})
