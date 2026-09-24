import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
// The REAL refusal class and tax-year guard, imported statically (static
// imports resolve before any module code below runs, so before the hooks
// are registered) and shared with the engine stub through global state —
// the route's `instanceof` check runs against the genuine class, never a
// doubled refusal.
import {
  assertTaxYear as realAssertTaxYear,
  OpeningBalanceSaveError as RealOpeningBalanceSaveError,
} from '@openbooks/engine/src/payroll/opening-balances.ts'

/**
 * F3-25: the adoption grid replayed full-row payloads from its stale loader
 * snapshot. The POST now carries each row's loader-served version into
 * `saveOpeningBalances`, non-string versions refuse by name (422), and a
 * version conflict from the engine answers 409 with the named per-row
 * errors. The engine boundary is stubbed; this file proves the adapter:
 * the version is threaded (not dropped) and the refusal maps to 409.
 * The guard itself is proven against a real database in
 * engine/src/payroll/opening-balance-versions.integration.test.ts.
 */

const stateKey = Symbol.for('openbooks.opening-balances-version-test')
interface RouteState {
  saveCalls: { rows: { employeePartyId: string; updatedAt?: string | null }[] }[]
  saveResult: unknown
  throwSave: unknown
  ErrorClass: typeof RealOpeningBalanceSaveError
  assertTaxYear: typeof realAssertTaxYear
}
const routeState: RouteState = {
  saveCalls: [],
  saveResult: { created: 0, updated: 1, deleted: 0, skipped: [], errors: [] },
  throwSave: null,
  ErrorClass: RealOpeningBalanceSaveError,
  assertTaxYear: realAssertTaxYear,
}
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      export const db = {
        execute() { return Promise.resolve({ rows: [] }) },
      }
      export async function withOrgTransaction(_orgId, fn) { return fn() }
      export function ambientTenantOrgId() { return null }
      export function currentRequestOrgResolver() { return null }
      export function registerRequestOrgResolver() {}
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' } }
      }
    `,
  ],
  [
    'mock:payroll-subsidiary-scope',
    `
      export async function guardPayrollEmployees() { return null }
    `,
  ],
  [
    'mock:payroll-scoped-views',
    `
      export async function scopedOpeningBalances() { throw new Error('not under test') }
    `,
  ],
  [
    'mock:opening-balances',
    `
      const state = globalThis[Symbol.for('openbooks.opening-balances-version-test')]
      export const OpeningBalanceSaveError = state.ErrorClass
      export const assertTaxYear = state.assertTaxYear
      export async function declaredProgramBaseFields() { return [] }
      export const OPENING_BALANCE_FIELDS = []
      export async function saveOpeningBalances(input) {
        state.saveCalls.push(input)
        if (state.throwSave) {
          const err = state.throwSave
          state.throwSave = null
          throw err
        }
        return state.saveResult
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll/opening-balances.ts') {
      return { url: 'mock:opening-balances', shortCircuit: true }
    }
    if (specifier === '../subsidiary-scope') return { url: 'mock:payroll-subsidiary-scope', shortCircuit: true }
    if (specifier.endsWith('/lib/payroll-scoped-views')) return { url: 'mock:payroll-scoped-views', shortCircuit: true }
    if (specifier.endsWith('/lib/feature-gates')) return { url: 'mock:feature-gates', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?opening-balances-version-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
// The genuine refusal class, shared with the stub above.
const OpeningBalanceSaveError = RealOpeningBalanceSaveError
hooks.deregister()

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function reset() {
  routeState.saveCalls = []
  routeState.throwSave = null
}

function post(body: unknown) {
  return POST(
    new Request('http://openbooks.test/api/payroll/opening-balances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('POST threads each row loader-served version into the save', async () => {
  reset()
  const res = await post({
    taxYear: 2026,
    rows: [{ employeePartyId: uuid(1), amounts: {}, updatedAt: '2026-09-01 00:00:00+00' }],
  })
  assert.equal(res.status, 200)
  assert.equal(routeState.saveCalls.length, 1)
  assert.equal(routeState.saveCalls[0]!.rows[0]!.updatedAt, '2026-09-01 00:00:00+00')
})

test('a row with no version arrives unguarded for callers that do not speak versions', async () => {
  reset()
  const res = await post({ taxYear: 2026, rows: [{ employeePartyId: uuid(1), amounts: {} }] })
  assert.equal(res.status, 200)
  assert.equal(routeState.saveCalls[0]!.rows[0]!.updatedAt, undefined)
})

test('a version conflict answers 409 with the named per-row errors', async () => {
  reset()
  routeState.throwSave = new OpeningBalanceSaveError({
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: [],
    errors: [{
      employeePartyId: uuid(1),
      employeeName: 'Ada',
      message: 'the carry-in for Ada changed since this screen was loaded — reload the page and re-enter your edits',
    }],
  })
  const res = await post({
    taxYear: 2026,
    rows: [{ employeePartyId: uuid(1), amounts: {}, updatedAt: 'stale' }],
  })
  assert.equal(res.status, 409)
  const body = (await res.json()) as {
    error: string
    errors: { employeePartyId: string; message: string }[]
    created: number
    updated: number
    deleted: number
  }
  assert.match(body.errors[0]!.message, /changed since/)
  assert.match(body.errors[0]!.message, /reload/)
  assert.deepEqual([body.created, body.updated, body.deleted], [0, 0, 0])
})

test('a non-string version refuses by name before anything is saved', async () => {
  reset()
  const res = await post({
    taxYear: 2026,
    rows: [{ employeePartyId: uuid(1), amounts: {}, updatedAt: 42 }],
  })
  assert.equal(res.status, 422)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /updatedAt/)
  assert.equal(routeState.saveCalls.length, 0)
})
