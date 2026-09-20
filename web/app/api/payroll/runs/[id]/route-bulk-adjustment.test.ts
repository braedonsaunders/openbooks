import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * POST bulk-adjustment — every malformed shape refuses by NAME (422), and the
 * refusal for one bad id among thousands names the offending value AND its
 * index. The engine boundary (`mutatePayRunAdjustment`) is mocked; this file
 * proves the adapter around it: which cause produced which sentence, that a
 * refusal commits nothing, and that the numeric limits accept their boundary
 * (2000 employees, 500-char note) while refusing past it.
 */

const stateKey = Symbol.for('openbooks.payroll-run-bulk-adjustment-test')
interface RouteState {
  ownedSubsidiaryId: string | null
  adjustmentCalls: unknown[]
}
const routeState: RouteState = { ownedSubsidiaryId: 'sub-1', adjustmentCalls: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(req) { return { ok: true, data: await req.json() } }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-bulk-adjustment-test')]
      export const db = {
        execute() { return Promise.resolve({ rows: state.ownedSubsidiaryId ? [{ subsidiaryId: state.ownedSubsidiaryId }] : [] }) },
      }
      export async function withOrgTransaction(_orgId, fn) { return fn() }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' }, permissions: new Set(['payroll.run']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function guardSubsidiaryScope() { return undefined }
    `,
  ],
  [
    'mock:payroll-run',
    `
      export class PayrollError extends Error {}
      export async function acknowledgePayRunRefusals() { throw new Error('not under test') }
      export async function calculatePayRun() { throw new Error('not under test') }
      export async function commitPayRun() { throw new Error('not under test') }
      export async function discardPayRun() { throw new Error('not under test') }
      export async function previewPayRunGl() { throw new Error('not under test') }
    `,
  ],
  ['mock:payroll-payment', `export async function recordPayRunPayment() { throw new Error('not under test') }`],
  ['mock:payroll-readiness', `export async function assertPayRunNotStale() {}`],
  [
    'mock:payroll-approval',
    `
      export async function assertPayRunApprovalReleased() { throw new Error('not under test') }
      export async function payRunApprovalState() { throw new Error('not under test') }
    `,
  ],
  ['mock:flows', `export async function submitForApproval() { throw new Error('not under test') }`],
  ['mock:payroll-outputs', `export async function emailRunStubs() { throw new Error('not under test') }`],
  ['mock:payroll-evidence', `export async function assemblePayRunEvidence() { throw new Error('not under test') }`],
  ['mock:payroll-scope', `export async function lockAndCheckPayrollRunPopulation() { throw new Error('not under test') }`],
  [
    'mock:payroll-run-adjustments',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-bulk-adjustment-test')]
      export function canonicalAdjustmentHours() { throw new Error('not under test') }
      export async function mutatePayRunAdjustment(input) { state.adjustmentCalls.push(input); return { ok: true } }
    `,
  ],
  [
    'mock:payroll-holiday-attestations',
    `export async function storedHolidayEligibilityForRun() { return {} }`,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/api/json') return { url: 'mock:json', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (['@openbooks/engine/src/payroll/error.ts', '@openbooks/engine/src/payroll/fences.ts', '@openbooks/engine/src/payroll/run-allocation.ts', '@openbooks/engine/src/payroll/run-calculation-evidence.ts', '@openbooks/engine/src/payroll/run-calculation.ts', '@openbooks/engine/src/payroll/run-calendar.ts', '@openbooks/engine/src/payroll/run-commit.ts', '@openbooks/engine/src/payroll/run-contracts.ts', '@openbooks/engine/src/payroll/run-lifecycle.ts', '@openbooks/engine/src/payroll/run-protection.ts', '@openbooks/engine/src/payroll/run-setup.ts', '@openbooks/engine/src/payroll/run-stub-records.ts', '@openbooks/engine/src/payroll/scope.ts'].includes(specifier)) return { url: 'mock:payroll-run', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll/payment.ts') return { url: 'mock:payroll-payment', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll/readiness.ts') return { url: 'mock:payroll-readiness', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll/approval.ts') return { url: 'mock:payroll-approval', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/flows/index.ts') return { url: 'mock:flows', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll/run-adjustments.ts') {
      return { url: 'mock:payroll-run-adjustments', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/payroll/holiday-attestations.ts') {
      return { url: 'mock:payroll-holiday-attestations', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/payroll/scope.ts') return { url: 'mock:payroll-scope', shortCircuit: true }
    if (specifier.endsWith('/lib/payroll-outputs')) return { url: 'mock:payroll-outputs', shortCircuit: true }
    if (specifier.endsWith('/lib/payroll-evidence')) return { url: 'mock:payroll-evidence', shortCircuit: true }
    if (specifier.endsWith('/lib/feature-gates')) return { url: 'mock:feature-gates', shortCircuit: true }
    if (specifier.endsWith('/lib/authz')) return { url: 'mock:authz', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payroll-run-bulk-adjustment-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const COMPONENT_ID = '00000000-0000-4000-8000-000000000002'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function reset() {
  routeState.ownedSubsidiaryId = 'sub-1'
  routeState.adjustmentCalls = []
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'bulk-adjustment',
    componentId: COMPONENT_ID,
    employeePartyIds: [uuid(1)],
    amount: '100.00',
    ...overrides,
  }
}

function post(body: unknown) {
  return POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
}

async function errorOf(body: unknown): Promise<{ status: number; error: string }> {
  const res = await post(body)
  const parsed = (await res.json()) as { error: string }
  return { status: res.status, error: parsed.error }
}

test('bulk-adjustment applies a valid batch', async () => {
  reset()
  const res = await post(valid())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, applied: 1 })
  assert.equal(routeState.adjustmentCalls.length, 1)
})

test('bulk-adjustment refuses a missing componentId naming the field and value', async () => {
  reset()
  const { componentId: _dropped, ...rest } = valid()
  void _dropped
  const { status, error } = await errorOf(rest)
  assert.equal(status, 422)
  assert.match(error, /componentId must be a pay component id — got "a undefined"/)
  assert.match(error, /adjustableComponents/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses a non-uuid componentId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ componentId: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /componentId "nope" is not a pay component id/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses a non-list employeePartyIds', async () => {
  reset()
  const { status, error } = await errorOf(valid({ employeePartyIds: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyIds must be a list of employee ids — got "nope"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses an empty employee list', async () => {
  reset()
  const { status, error } = await errorOf(valid({ employeePartyIds: [] }))
  assert.equal(status, 422)
  assert.match(error, /needs at least one employee/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses 2001 employees naming the limit', async () => {
  reset()
  const ids = Array.from({ length: 2001 }, (_, i) => uuid(i + 1))
  const { status, error } = await errorOf(valid({ employeePartyIds: ids }))
  assert.equal(status, 422)
  assert.match(error, /accepts at most 2000 employees at once — got 2001/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment accepts exactly 2000 employees', async () => {
  reset()
  const ids = Array.from({ length: 2000 }, (_, i) => uuid(i + 1))
  const res = await post(valid({ employeePartyIds: ids }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, applied: 2000 })
  assert.equal(routeState.adjustmentCalls.length, 2000)
})

test('bulk-adjustment names the offending id and its index', async () => {
  reset()
  const { status, error } = await errorOf(valid({ employeePartyIds: [uuid(1), uuid(2), 'nope', uuid(4)] }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyIds\[2\] "nope" is not an employee id/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses a non-numeric amount naming the value', async () => {
  reset()
  const { status, error } = await errorOf(valid({ amount: 'abc' }))
  assert.equal(status, 422)
  assert.match(error, /amount must be an amount — "abc" is not a number/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses an over-scale amount naming the limit', async () => {
  reset()
  const { status, error } = await errorOf(valid({ amount: '1234.56789' }))
  assert.equal(status, 422)
  assert.match(error, /amount allows at most 4 decimal places — got 5/)
})

test('bulk-adjustment refuses a thousands separator, not a number error', async () => {
  reset()
  const { status, error } = await errorOf(valid({ amount: '1,234.56' }))
  assert.equal(status, 422)
  assert.match(error, /must not contain a thousands separator/)
})

test('bulk-adjustment reads a decimal comma as a decimal point, never grouping', async () => {
  reset()
  const { status, error } = await errorOf(valid({ amount: '12,34' }))
  assert.equal(status, 422)
  assert.match(error, /must use "\." as the decimal point — write "12,34" as "12\.34"/)
})

test('bulk-adjustment refuses a currency symbol and scientific notation distinctly', async () => {
  reset()
  const currency = await errorOf(valid({ amount: '$1200' }))
  assert.equal(currency.status, 422)
  assert.match(currency.error, /must not contain a currency symbol/)
  const scientific = await errorOf(valid({ amount: '1.5E+05' }))
  assert.equal(scientific.status, 422)
  assert.match(scientific.error, /written out in full/)
})

test('bulk-adjustment refuses a non-text note naming the type', async () => {
  reset()
  const { status, error } = await errorOf(valid({ note: 42 }))
  assert.equal(status, 422)
  assert.match(error, /note must be text — got "42"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment refuses a 501-character note naming the limit', async () => {
  reset()
  const { status, error } = await errorOf(valid({ note: 'x'.repeat(501) }))
  assert.equal(status, 422)
  assert.match(error, /note is limited to 500 characters — got 501/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('bulk-adjustment accepts a 500-character note', async () => {
  reset()
  const res = await post(valid({ note: 'x'.repeat(500) }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, applied: 1 })
})

test('bulk-adjustment refuses a non-boolean replaceComponent', async () => {
  reset()
  const { status, error } = await errorOf(valid({ replaceComponent: 'yes' }))
  assert.equal(status, 422)
  assert.match(error, /replaceComponent must be true or false — got "yes"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})
