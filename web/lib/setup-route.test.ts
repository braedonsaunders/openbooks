import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules'
import { SETUP_ENTITY_BY_KEY } from './setup/registry.ts'

test('the shared currency registry stays readable but is not tenant-mutable', () => {
  const currencies = SETUP_ENTITY_BY_KEY.get('currencies')
  assert.ok(currencies)
  assert.equal(currencies.orgScoped, false, 'currencies must remain one shared reference table')
  assert.equal(currencies.readOnly, true, 'tenant setup must not own the shared registry')
  assert.deepEqual(
    currencies.fields.map((field) => field.key),
    ['code', 'name', 'minorUnits'],
    'currency fields remain available for reads and reference pickers',
  )
})

const routeState = {
  executeCalls: 0,
  transactionCalls: 0,
}
const routeStateKey = Symbol.for('openbooks.currency-route-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeStateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'tenant-a', id: 'admin-a' }, permissions: new Set(['admin.setup.manage']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.currency-route-test')]
      export const ambientTenantOrgId = () => 'tenant-a'
      export const withBypassContext = (fn) => fn()
      export const withOrgTransaction = () => { state.transactionCalls++; throw new Error('read-only currency route must not open a transaction') }
      export const db = {
        execute() { state.executeCalls++; return Promise.resolve({ rows: [] }) },
        transaction() { state.transactionCalls++; throw new Error('read-only currency route must not open a transaction') },
      }
    `,
  ],
  [
    'mock:features',
    `
      export function featureEnabled() { return true }
      export function featureGateLockKey() { throw new Error('read-only currency route must not request a feature lock') }
      export async function isFeatureEnabled() { return true }
      // The currencies table is feature-gated on multiCurrency: the fixture
      // enables it so the refusal under test is the read-only 405, not the
      // hidden-entity 404 a feature-off org correctly receives first.
      export async function resolvedFeatureState() { return { multiCurrency: true } }
      export async function subsidiaryFeatureEnabled() { return true }
      export async function orgFeatureState() { return {} }
    `,
  ],
  [
    'mock:payroll-run',
    `
      export class PayrollError extends Error {}
      export function payPeriodsPerYearProblem() { return null }
      export function semiMonthlyAnchorProblem() { return null }
      export async function payScheduleSubsidiaryProblem() { return null }
      export async function rescopePayScheduleRuns() { return { reresolved: 0, untouched: 0, skipped: [] } }
    `,
  ],
  [
    'mock:payroll-filing-registry',
    `
      export function filingAccountProblem() { return null }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/authz' && context.parentURL?.endsWith('/web/lib/api/route.ts')) {
      return { url: 'mock:authz', shortCircuit: true }
    }
    const routeParent = context.parentURL?.includes('%5Bentity%5D') || context.parentURL?.includes('[entity]')
    if (specifier === '../../../../../lib/authz' && routeParent) {
      return { url: 'mock:authz', shortCircuit: true }
    }
    if (specifier === '../../../../../lib/features' || specifier === '../features') {
      return { url: 'mock:features', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return { url: 'mock:db', shortCircuit: true }
    }
    if (['@openbooks/engine/src/payroll/fences.ts', '@openbooks/engine/src/payroll/run-allocation.ts', '@openbooks/engine/src/payroll/run-calculation-evidence.ts', '@openbooks/engine/src/payroll/run-calculation.ts', '@openbooks/engine/src/payroll/run-calendar.ts', '@openbooks/engine/src/payroll/run-commit.ts', '@openbooks/engine/src/payroll/run-contracts.ts', '@openbooks/engine/src/payroll/run-lifecycle.ts', '@openbooks/engine/src/payroll/run-protection.ts', '@openbooks/engine/src/payroll/run-setup.ts', '@openbooks/engine/src/payroll/run-stub-records.ts', '@openbooks/engine/src/payroll/scope.ts'].includes(specifier)) {
      return { url: 'mock:payroll-run', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/payroll/filing-registry.ts') {
      return { url: 'mock:payroll-filing-registry', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})
stubModules({
  navigation: true,
  authz: { source: mockSources.get('mock:authz')! },
  features: { source: mockSources.get('mock:features')! },
})

// Register tests before awaiting route evaluation: --test-force-exit may mark
// a test declared after a top-level await as cancelled even after its body has
// completed. Keeping the import promise in the test also lets the hook remain
// active until every intercepted dependency has loaded.
const routeUrl = '../app/api/admin/setup/[entity]/route.ts?currency-route-test'
const routeReady = import(routeUrl).then((module) => module as typeof import('../app/api/admin/setup/[entity]/route.ts'))
test.after(() => hooks.deregister())

test('currency mutations fail closed before parsing or touching the database', async () => {
  const { POST, PATCH, DELETE } = await routeReady
  routeState.executeCalls = 0
  routeState.transactionCalls = 0
  const params = { params: Promise.resolve({ entity: 'currencies' }) }
  // POST requires an Idempotency-Key, checked before the preflight: the
  // malformed bodies below still prove the read-only refusal lands before
  // parsing, with the header a real drawer call always sends.
  const keyHeaders = { 'Idempotency-Key': '00000000-0000-4000-8000-00000000c001' }
  const responses = [
    await POST(new Request('http://localhost/api/admin/setup/currencies', { method: 'POST', headers: keyHeaders, body: '{not-json' }), params),
    await PATCH(new Request('http://localhost/api/admin/setup/currencies', { method: 'PATCH', body: '{not-json' }), params),
    await DELETE(new Request('http://localhost/api/admin/setup/currencies', { method: 'DELETE' }), params),
  ]
  for (const response of responses) {
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { error: 'read-only' })
  }
  assert.equal(routeState.executeCalls, 0)
  assert.equal(routeState.transactionCalls, 0)
})
