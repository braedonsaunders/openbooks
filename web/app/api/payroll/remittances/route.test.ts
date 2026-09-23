import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * POST create-bill — every malformed shape refuses by NAME (422). The engine
 * boundary (`createRemittanceBill`) and the scope guards are mocked; this
 * file proves the adapter around them: which cause produced which sentence,
 * that a refusal creates no bill, and that a one-day period (from === to) is
 * accepted while an inverted one is refused.
 */

const stateKey = Symbol.for('openbooks.payroll-remittances-post-test')
interface RouteState {
  billCalls: unknown[]
}
const routeState: RouteState = { billCalls: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' }, permissions: new Set(['payroll.run']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:payroll-remittance',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-remittances-post-test')]
      export async function createRemittanceBill(_orgId, _actorId, input) {
        state.billCalls.push(input)
        return { billId: 'bill-1' }
      }
      export async function payrollRemittanceSummary() { throw new Error('not under test') }
    `,
  ],
  [
    'mock:payroll-run',
    `export class PayrollError extends Error {}`,
  ],
  [
    'mock:subsidiary-scope',
    `
      export async function guardPayrollFilingAccounts() { return undefined }
      export async function guardPayrollVendor() { return undefined }
      export async function guardRemittancePeriod() { return undefined }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // '@/lib/api/json' is not mocked: never double the validation boundary.
    if (specifier === '@openbooks/engine/src/payroll/remittance.ts') {
      return { url: 'mock:payroll-remittance', shortCircuit: true }
    }
    if (['@openbooks/engine/src/payroll/error.ts', '@openbooks/engine/src/payroll/fences.ts', '@openbooks/engine/src/payroll/run-allocation.ts', '@openbooks/engine/src/payroll/run-calculation-evidence.ts', '@openbooks/engine/src/payroll/run-calculation.ts', '@openbooks/engine/src/payroll/run-calendar.ts', '@openbooks/engine/src/payroll/run-commit.ts', '@openbooks/engine/src/payroll/run-contracts.ts', '@openbooks/engine/src/payroll/run-lifecycle.ts', '@openbooks/engine/src/payroll/run-protection.ts', '@openbooks/engine/src/payroll/run-setup.ts', '@openbooks/engine/src/payroll/run-stub-records.ts', '@openbooks/engine/src/payroll/scope.ts'].includes(specifier)) return { url: 'mock:payroll-run', shortCircuit: true }
    if (specifier.endsWith('/lib/feature-gates')) return { url: 'mock:feature-gates', shortCircuit: true }
    if (specifier === '../subsidiary-scope') return { url: 'mock:subsidiary-scope', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payroll-remittances-post-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const PARTY_ID = '00000000-0000-4000-8000-000000000001'
const FILING_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const SUBSIDIARY_ID = '00000000-0000-4000-8000-000000000003'

function reset() {
  routeState.billCalls = []
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'create-bill',
    partyId: PARTY_ID,
    from: '2026-09-01',
    to: '2026-09-30',
    ...overrides,
  }
}

function post(body: unknown) {
  return POST(
    new Request('http://openbooks.test/api/payroll/remittances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function errorOf(body: unknown): Promise<{ status: number; error: string }> {
  const res = await post(body)
  const parsed = (await res.json()) as { error: string }
  return { status: res.status, error: parsed.error }
}

test('create-bill creates the bill for a valid request', async () => {
  reset()
  const res = await post(valid())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, billId: 'bill-1' })
  assert.equal(routeState.billCalls.length, 1)
})

test('create-bill refuses a missing partyId naming the field and value', async () => {
  reset()
  const { partyId: _dropped, ...rest } = valid()
  void _dropped
  const { status, error } = await errorOf(rest)
  assert.equal(status, 422)
  assert.match(error, /partyId must be a vendor id — got "a undefined"/)
  assert.match(error, /remittance summary/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses a non-uuid partyId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ partyId: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /partyId "nope" is not a vendor id/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses a malformed from naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ from: 'Sept 1' }))
  assert.equal(status, 422)
  assert.match(error, /from must be a date "YYYY-MM-DD" — got "Sept 1"/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses a malformed to naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ to: 'yesterday' }))
  assert.equal(status, 422)
  assert.match(error, /to must be a date "YYYY-MM-DD" — got "yesterday"/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses an inverted period naming both bounds', async () => {
  reset()
  const { status, error } = await errorOf(valid({ from: '2026-10-01', to: '2026-09-01' }))
  assert.equal(status, 422)
  assert.match(error, /from "2026-10-01" is after to "2026-09-01"/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill accepts a one-day period', async () => {
  reset()
  const res = await post(valid({ from: '2026-09-01', to: '2026-09-01' }))
  assert.equal(res.status, 200)
  assert.equal(routeState.billCalls.length, 1)
})

test('create-bill refuses an impossible from date naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ from: '2026-02-30' }))
  assert.equal(status, 422)
  assert.match(error, /from "2026-02-30" is not a real calendar date/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses an impossible to date naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ to: '2026-13-01' }))
  assert.equal(status, 422)
  assert.match(error, /to "2026-13-01" is not a real calendar date/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill accepts a real leap day', async () => {
  reset()
  const res = await post(valid({ from: '2024-02-29', to: '2024-02-29' }))
  assert.equal(res.status, 200)
  assert.equal(routeState.billCalls.length, 1)
})

test('create-bill refuses a malformed filingAccountId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ filingAccountId: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /filingAccountId "nope" is not a filing account id/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill refuses a malformed subsidiaryId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ subsidiaryId: 42 }))
  assert.equal(status, 422)
  assert.match(error, /subsidiaryId "42" is not a subsidiary id/)
  assert.equal(routeState.billCalls.length, 0)
})

test('create-bill accepts named filing account and subsidiary', async () => {
  reset()
  const res = await post(valid({ filingAccountId: FILING_ACCOUNT_ID, subsidiaryId: SUBSIDIARY_ID }))
  assert.equal(res.status, 200)
  assert.equal(routeState.billCalls.length, 1)
})
