import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { isUuid } from '../../../../../lib/list-params'

/**
 * POST runs/[id] — every remaining collapsed refusal names its cause (422).
 *
 * Covers the six sites the bulk-adjustment batch left behind: the
 * single-adjustment and hours paths of 'invalid adjustment' (2 sites),
 * delete-adjustment's 'invalid adjustment', 'invalid scope', 'invalid
 * holidayEligibility', and this file's 'invalid employee'. Each refusal names
 * the field, the value received (capped via suppliedValue), and a remedy that
 * exists; amounts reuse the shared decimal classifier. The engine boundary
 * (`mutatePayRunAdjustment`) is mocked; this file proves the adapter around
 * it plus a PARITY table per site showing the old collapsed guard and the new
 * per-cause path agree on accept/refuse for every input.
 *
 * Unit partition: all dependencies mocked or pure; no database.
 */

const stateKey = Symbol.for('openbooks.payroll-run-id-refusals-test')
interface RouteState {
  ownedSubsidiaryId: string | null
  adjustmentCalls: unknown[]
  excludedIds: string[]
}
const routeState: RouteState = { ownedSubsidiaryId: 'sub-1', adjustmentCalls: [], excludedIds: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

// The route canonicalizes hours through the engine's real helper, so the mock
// provides a verbatim copy of engine/src/payroll/run-adjustments.ts
// canonicalAdjustmentHours wired to the real canonicalDecimal (pure, no
// imports of its own). The copy is deliberate: the mock must refuse exactly
// what the engine refuses.

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-id-refusals-test')]
      export const db = {
        // set-scope diffs the requested scope against the CURRENT exclusions:
        // answer that read from state, and the owning-document read as before.
        execute(query) {
          let text = ''
          try { text = JSON.stringify(query) } catch { text = '' }
          if (text.includes('pay_run_adjustments')) {
            return Promise.resolve({ rows: state.excludedIds.map((id) => ({ employee_party_id: id })) })
          }
          return Promise.resolve({ rows: state.ownedSubsidiaryId ? [{ subsidiaryId: state.ownedSubsidiaryId }] : [] })
        },
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
      export { canonicalAdjustmentHours } from ${JSON.stringify(import.meta.resolve('@openbooks/engine/src/payroll/run-adjustments.ts'))}
      const state = globalThis[Symbol.for('openbooks.payroll-run-id-refusals-test')]
      export async function mutatePayRunAdjustment(input) { state.adjustmentCalls.push(input); return { changed: true } }
      export class PayRunAdjustmentIdempotencyConflict extends Error {}
      export function payRunBulkAdjustmentId(batchKey, employeePartyId) { return batchKey + ':' + employeePartyId }
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
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (['@openbooks/engine/src/payroll/run-calculation.ts', '@openbooks/engine/src/payroll/run-commit.ts', '@openbooks/engine/src/payroll/run-lifecycle.ts'].includes(specifier)) return { url: 'mock:payroll-run', shortCircuit: true }
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

const routeUrl = './route.ts?payroll-run-id-refusals-test'
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
  routeState.excludedIds = []
}

function validAdd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'add-adjustment',
    employeePartyId: uuid(1),
    componentId: COMPONENT_ID,
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
  const parsed = (await res.json()) as { error?: string }
  return { status: res.status, error: parsed.error ?? '' }
}

// ---------------------------------------------------------------------------
// holidayEligibility: five causes, one collapsed 'invalid holidayEligibility'
// ---------------------------------------------------------------------------

test('holidayEligibility refuses a non-map naming the field and value', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ holidayEligibility: null }))
  assert.equal(status, 422)
  assert.match(error, /holidayEligibility must be a map of employee ids/)
  assert.match(error, /got "a null"/)
  assert.match(error, /or omit it/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('holidayEligibility refuses a non-uuid key naming the key', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ holidayEligibility: { nope: {} } }))
  assert.equal(status, 422)
  assert.match(error, /holidayEligibility key "nope" is not an employee id/)
  assert.match(error, /fix that key/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('holidayEligibility refuses non-object facts naming the employee', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ holidayEligibility: { [uuid(1)]: 'yes' } }))
  assert.equal(status, 422)
  assert.match(error, new RegExp(`holidayEligibility\\["${uuid(1)}"\\] must be a map of attestation facts`))
  assert.match(error, /got "yes"/)
  assert.match(error, /paidOnCommission and absentWithoutConsent/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('holidayEligibility refuses an unknown fact naming it and the two that exist', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ holidayEligibility: { [uuid(1)]: { onLeave: true } } }))
  assert.equal(status, 422)
  assert.match(error, /has unknown fact "onLeave"/)
  assert.match(error, /only paidOnCommission and absentWithoutConsent exist/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('holidayEligibility refuses a non-boolean fact naming the field and value', async () => {
  reset()
  const { status, error } = await errorOf(
    validAdd({ holidayEligibility: { [uuid(1)]: { paidOnCommission: 'yes' } } }),
  )
  assert.equal(status, 422)
  assert.match(error, /paidOnCommission must be true or false/)
  assert.match(error, /got "yes"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('holidayEligibility accepts absence, an empty map, and a full attestation', async () => {
  for (const value of [
    undefined,
    {},
    { [uuid(1)]: {} },
    { [uuid(1)]: { paidOnCommission: true, absentWithoutConsent: false } },
  ]) {
    reset()
    const res = await post(validAdd({ holidayEligibility: value }))
    assert.equal(res.status, 200, `holidayEligibility ${JSON.stringify(value)} should be accepted`)
    assert.equal(routeState.adjustmentCalls.length, 1)
  }
})

// ---------------------------------------------------------------------------
// add-adjustment hours: a scale-2 amount into numeric(12,2)
// ---------------------------------------------------------------------------

test('hours refuses an unreadable value through the shared decimal classifier', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ hours: 'abc' }))
  assert.equal(status, 422)
  assert.match(error, /hours must be a number of hours — "abc" is not a number/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('hours refuses a third decimal place naming the scale', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ hours: '1.234' }))
  assert.equal(status, 422)
  assert.match(error, /hours allows at most 2 decimal places — got 3/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('hours reads a decimal comma as a decimal point, never grouping', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ hours: '12,34' }))
  assert.equal(status, 422)
  assert.match(error, /hours must use "\." as the decimal point — write "12,34" as "12\.34"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('hours refuses a thousands separator, not a number error', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ hours: '1,234.56' }))
  assert.equal(status, 422)
  assert.match(error, /hours must not contain a thousands separator/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('hours refuses a negative value naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ hours: '-3' }))
  assert.equal(status, 422)
  assert.match(error, /hours must not be negative — got "-3"/)
  assert.match(error, /pass zero or more hours, or omit hours/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('hours refuses eleven whole digits naming the limit, accepts ten', async () => {
  reset()
  const refused = await errorOf(validAdd({ hours: '12345678901' }))
  assert.equal(refused.status, 422)
  assert.match(refused.error, /hours is out of range — at most 10 whole digits fit/)
  assert.match(refused.error, /got "12345678901"/)
  assert.equal(routeState.adjustmentCalls.length, 0)

  reset()
  const res = await post(validAdd({ hours: '1234567890.12' }))
  assert.equal(res.status, 200)
  assert.equal(routeState.adjustmentCalls.length, 1)
})

test('hours accepts absence, blank, zero, and two-decimal values', async () => {
  for (const hours of [undefined, null, '', '0', '0.00', '7.5', '37.25']) {
    reset()
    const res = await post(validAdd({ hours }))
    assert.equal(res.status, 200, `hours ${JSON.stringify(hours)} should be accepted`)
    assert.equal(routeState.adjustmentCalls.length, 1)
  }
})

test('add-adjustment passes canonical hours to the engine', async () => {
  reset()
  const res = await post(validAdd({ hours: '7.50' }))
  assert.equal(res.status, 200)
  const calls = routeState.adjustmentCalls as Array<{ mutation: { hours: unknown } }>
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.mutation.hours, '7.5')
})

// ---------------------------------------------------------------------------
// add-adjustment: the collapsed guard over employee, component, amount, note
// ---------------------------------------------------------------------------

test('add-adjustment refuses a non-string employeePartyId naming the type', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ employeePartyId: 42 }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyId must be an employee id — got "42"/)
  assert.match(error, /pass the employee as an employee id/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a malformed employeePartyId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ employeePartyId: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyId "nope" is not an employee id/)
  assert.match(error, /fix the id and try again/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a non-string componentId naming the adjustable list', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ componentId: 42 }))
  assert.equal(status, 422)
  assert.match(error, /componentId must be a pay component id — got "42"/)
  assert.match(error, /adjustableComponents/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a malformed componentId naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ componentId: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /componentId "nope" is not a pay component id/)
  assert.match(error, /adjustableComponents/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses an unreadable amount naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ amount: 'abc' }))
  assert.equal(status, 422)
  assert.match(error, /amount must be an amount — "abc" is not a number/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a five-decimal amount naming the scale', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ amount: '1.23456' }))
  assert.equal(status, 422)
  assert.match(error, /amount allows at most 4 decimal places — got 5/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a non-text note naming the type', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ note: 42 }))
  assert.equal(status, 422)
  assert.match(error, /note must be text — got "42"/)
  assert.match(error, /pass the note as text or omit it/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('add-adjustment refuses a 501-character note naming the limit, accepts 500', async () => {
  reset()
  const refused = await errorOf(validAdd({ note: 'x'.repeat(501) }))
  assert.equal(refused.status, 422)
  assert.match(refused.error, /note is limited to 500 characters — got 501/)
  assert.equal(routeState.adjustmentCalls.length, 0)

  reset()
  const res = await post(validAdd({ note: 'x'.repeat(500) }))
  assert.equal(res.status, 200)
  assert.equal(routeState.adjustmentCalls.length, 1)
})

test('add-adjustment refuses a non-boolean replaceComponent', async () => {
  reset()
  const { status, error } = await errorOf(validAdd({ replaceComponent: 'yes' }))
  assert.equal(status, 422)
  assert.match(error, /replaceComponent must be true or false — got "yes"/)
  assert.match(error, /pass a boolean or omit it/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

// ---------------------------------------------------------------------------
// delete-adjustment: type vs shape, not one 'invalid adjustment'
// ---------------------------------------------------------------------------

test('delete-adjustment refuses a missing adjustmentId naming the type', async () => {
  reset()
  const { status, error } = await errorOf({ action: 'delete-adjustment' })
  assert.equal(status, 422)
  assert.match(error, /adjustmentId must be a pay adjustment id — got "a undefined"/)
  assert.match(error, /pass the adjustment to delete as an id/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('delete-adjustment refuses a malformed adjustmentId naming the value', async () => {
  reset()
  const { status, error } = await errorOf({ action: 'delete-adjustment', adjustmentId: 'nope' })
  assert.equal(status, 422)
  assert.match(error, /adjustmentId "nope" is not a pay adjustment id/)
  assert.match(error, /fix the id and try again/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('delete-adjustment accepts a well-formed id', async () => {
  reset()
  const res = await post({ action: 'delete-adjustment', adjustmentId: uuid(9) })
  assert.equal(res.status, 200)
  assert.equal(routeState.adjustmentCalls.length, 1)
})

// ---------------------------------------------------------------------------
// set-scope: two lists, a limit, and two indexed entries
// ---------------------------------------------------------------------------

function validScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'set-scope',
    employeePartyIds: [uuid(1)],
    rosterPartyIds: [uuid(1), uuid(2)],
    ...overrides,
  }
}

test('set-scope refuses a non-list employeePartyIds naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validScope({ employeePartyIds: 'nope' }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyIds must be a list of employee ids — got "nope"/)
  assert.match(error, /pass the employees to include as a list/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('set-scope refuses a non-list rosterPartyIds naming the value', async () => {
  reset()
  const { status, error } = await errorOf(validScope({ rosterPartyIds: null }))
  assert.equal(status, 422)
  assert.match(error, /rosterPartyIds must be a list of employee ids — got "a null"/)
  assert.match(error, /pass the run roster as a list/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('set-scope refuses 2001 roster employees naming the limit, accepts 2000', async () => {
  reset()
  const ids = Array.from({ length: 2001 }, (_, i) => uuid(i + 1))
  const refused = await errorOf(validScope({ employeePartyIds: [ids[0]], rosterPartyIds: ids }))
  assert.equal(refused.status, 422)
  assert.match(refused.error, /set-scope accepts at most 2000 roster employees at once — got 2001/)
  assert.equal(routeState.adjustmentCalls.length, 0)

  reset()
  const twoThousand = Array.from({ length: 2000 }, (_, i) => uuid(i + 1))
  const res = await post(validScope({ employeePartyIds: [twoThousand[0]], rosterPartyIds: twoThousand }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, included: 1, excluded: 1999 })
  // The kept member is already in scope and staying: diffed, not replayed.
  assert.equal(routeState.adjustmentCalls.length, 1999)
})

test('set-scope names a bad included id AND its index', async () => {
  reset()
  const { status, error } = await errorOf(validScope({ employeePartyIds: [uuid(1), 'nope'] }))
  assert.equal(status, 422)
  assert.match(error, /employeePartyIds\[1\] "nope" is not an employee id/)
  assert.match(error, /fix that entry and try again/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('set-scope names a bad roster id AND its index', async () => {
  reset()
  const { status, error } = await errorOf(validScope({ rosterPartyIds: [uuid(1), 'nope'] }))
  assert.equal(status, 422)
  assert.match(error, /rosterPartyIds\[1\] "nope" is not an employee id/)
  assert.match(error, /fix that entry and try again/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('set-scope accepts an empty included list and an empty roster', async () => {
  reset()
  const excludeAll = await post(validScope({ employeePartyIds: [], rosterPartyIds: [uuid(1)] }))
  assert.equal(excludeAll.status, 200)
  assert.deepEqual(await excludeAll.json(), { ok: true, included: 0, excluded: 1 })

  reset()
  const emptyRoster = await post(validScope({ employeePartyIds: [], rosterPartyIds: [] }))
  assert.equal(emptyRoster.status, 200)
  assert.deepEqual(await emptyRoster.json(), { ok: true, included: 0, excluded: 0 })
})

test('set-scope mutates only what changes: members staying in or out are skipped', async () => {
  reset()
  routeState.excludedIds = [uuid(2)]
  const res = await post(validScope({ employeePartyIds: [uuid(1)], rosterPartyIds: [uuid(1), uuid(2)] }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, included: 1, excluded: 1 })
  // uuid(1) is in scope and staying; uuid(2) is out and staying out.
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('set-scope mutates only what changes: one removal and one re-add', async () => {
  reset()
  routeState.excludedIds = [uuid(2)]
  const res = await post(validScope({ employeePartyIds: [uuid(1), uuid(2)], rosterPartyIds: [uuid(1), uuid(2), uuid(3)] }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, included: 2, excluded: 1 })
  // uuid(1) stays in (skipped); uuid(2) is re-added; uuid(3) is removed.
  assert.equal(routeState.adjustmentCalls.length, 2)
  const actions = (routeState.adjustmentCalls as { mutation: { action: string; employeePartyId: string } }[])
    .map((call) => `${call.mutation.action}:${call.mutation.employeePartyId}`)
    .sort()
  assert.deepEqual(actions, [`exclude:${uuid(3)}`, `include:${uuid(2)}`])
})

// ---------------------------------------------------------------------------
// exclude/include-employee: this file's 'invalid employee'
// ---------------------------------------------------------------------------

test('exclude-employee refuses a non-string employeePartyId naming the type', async () => {
  reset()
  const { status, error } = await errorOf({ action: 'exclude-employee', employeePartyId: 42 })
  assert.equal(status, 422)
  assert.match(error, /employeePartyId must be an employee id — got "42"/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('include-employee refuses a malformed employeePartyId naming the value', async () => {
  reset()
  const { status, error } = await errorOf({ action: 'include-employee', employeePartyId: 'nope' })
  assert.equal(status, 422)
  assert.match(error, /employeePartyId "nope" is not an employee id/)
  assert.match(error, /fix the id and try again/)
  assert.equal(routeState.adjustmentCalls.length, 0)
})

test('exclude-employee and include-employee accept a well-formed id', async () => {
  for (const action of ['exclude-employee', 'include-employee']) {
    reset()
    const res = await post({ action, employeePartyId: uuid(1) })
    assert.equal(res.status, 200, `${action} should be accepted`)
    assert.equal(routeState.adjustmentCalls.length, 1)
  }
})

// ---------------------------------------------------------------------------
// PARITY: the old collapsed guard and the new per-cause path must agree on
// accept/refuse for every input. The oracles below are verbatim copies of the
// pre-fix predicates in route.ts at 2acbee344 (and of
// canonicalAdjustmentHours in engine/src/payroll/run-adjustments.ts); the
// "new" verdict is the live route's HTTP status. Agreement proves the change
// split causes without moving the boundary. Every refusal must also differ
// from the old collapsed literal — otherwise the literal survived.
// ---------------------------------------------------------------------------

interface HolidayFacts {
  paidOnCommission?: boolean
  absentWithoutConsent?: boolean
}

// Oracle: parseHolidayEligibility verbatim from route.ts at 2acbee344.
function oldParseHolidayEligibility(value: unknown): Record<string, HolidayFacts> | null {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const clean: Record<string, HolidayFacts> = {}
  for (const [employeeId, facts] of Object.entries(value as Record<string, unknown>)) {
    if (!isUuid(employeeId)) return null
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return null
    const entry: HolidayFacts = {}
    for (const [key, fact] of Object.entries(facts as Record<string, unknown>)) {
      if ((key !== 'paidOnCommission' && key !== 'absentWithoutConsent') || typeof fact !== 'boolean') {
        return null
      }
      entry[key as keyof HolidayFacts] = fact as boolean
    }
    clean[employeeId] = entry
  }
  return clean
}

function oldHolidayRefuses(value: unknown): boolean {
  return value !== undefined && oldParseHolidayEligibility(value) === null
}

// Oracle: canonicalAdjustmentHours verbatim from
// engine/src/payroll/run-adjustments.ts (mock carries the same copy).
function oldCanonicalAdjustmentHours(value: unknown): string | null {
  if (value == null || value === '') return null
  const exact = canonicalDecimal(value, 2)
  if (exact === null || exact.startsWith('-')) return null
  if (exact.replace(/^[+]/, '').split('.')[0]!.replace(/^0+/, '').length > 10) return null
  return exact
}

// Oracle: the add-adjustment guard verbatim from route.ts at 2acbee344.
function oldAddRefuses(body: Record<string, unknown>): boolean {
  const { employeePartyId, componentId, amount, hours, note, replaceComponent } = body
  let hoursRaw: string | null = null
  if (hours != null && hours !== '') {
    hoursRaw = oldCanonicalAdjustmentHours(hours)
    if (hoursRaw === null) return true
  }
  return (
    typeof employeePartyId !== 'string' ||
    !isUuid(employeePartyId) ||
    typeof componentId !== 'string' ||
    !isUuid(componentId) ||
    canonicalDecimal(amount, 4) === null ||
    (note != null && (typeof note !== 'string' || (note as string).length > 500)) ||
    (replaceComponent != null && typeof replaceComponent !== 'boolean')
  )
}

// Oracle: the delete-adjustment guard verbatim from route.ts at 2acbee344.
function oldDeleteRefuses(body: Record<string, unknown>): boolean {
  return typeof body.adjustmentId !== 'string' || !isUuid(body.adjustmentId as string)
}

// Oracle: the set-scope guard verbatim from route.ts at 2acbee344.
function oldScopeRefuses(body: Record<string, unknown>): boolean {
  const included = Array.isArray(body.employeePartyIds) ? body.employeePartyIds : null
  const roster = Array.isArray(body.rosterPartyIds) ? body.rosterPartyIds : null
  const uuidish = (v: unknown) => typeof v === 'string' && isUuid(v)
  return (
    !included ||
    !roster ||
    (roster as unknown[]).length > 2000 ||
    !(included as unknown[]).every(uuidish) ||
    !(roster as unknown[]).every(uuidish)
  )
}

// Oracle: the exclude/include-employee guard verbatim from route.ts at 2acbee344.
function oldEmployeeRefuses(body: Record<string, unknown>): boolean {
  return typeof body.employeePartyId !== 'string' || !isUuid(body.employeePartyId as string)
}

async function refused(body: unknown): Promise<{ refused: boolean; error: string }> {
  reset()
  const { status, error } = await errorOf(body)
  assert.ok(status === 200 || status === 422, `unexpected status ${status} for ${JSON.stringify(body)}`)
  return { refused: status === 422, error }
}

test('PARITY holidayEligibility: old guard and new causes agree on every input', async () => {
  const table: unknown[] = [
    undefined,
    null,
    'x',
    42,
    true,
    [],
    {},
    { nope: {} },
    { [uuid(1)]: null },
    { [uuid(1)]: [] },
    { [uuid(1)]: 'yes' },
    { [uuid(1)]: {} },
    { [uuid(1)]: { paidOnCommission: true } },
    { [uuid(1)]: { paidOnCommission: 'yes' } },
    { [uuid(1)]: { onLeave: true } },
    { [uuid(1)]: { paidOnCommission: true, absentWithoutConsent: false } },
    { [uuid(1)]: { absentWithoutConsent: 1 } },
    { [uuid(1)]: {}, [uuid(2)]: { paidOnCommission: false } },
    { [uuid(1)]: {}, nope: {} },
  ]
  for (const value of table) {
    const expected = oldHolidayRefuses(value)
    const { refused: actual, error } = await refused(validAdd({ holidayEligibility: value }))
    assert.equal(actual, expected, `holidayEligibility ${JSON.stringify(value)}: old=${expected} new=${actual}`)
    if (actual) {
      assert.notEqual(error, 'invalid holidayEligibility', `literal survived for ${JSON.stringify(value)}`)
      assert.match(error, /holidayEligibility/)
    }
  }
})

test('PARITY add-adjustment: old guard and new causes agree on every input', async () => {
  const base = validAdd()
  const bodies: Record<string, unknown>[] = []
  for (const employeePartyId of [undefined, null, 42, true, 'nope', '', '   ', uuid(1)]) {
    bodies.push({ ...base, employeePartyId })
  }
  for (const componentId of [undefined, null, 42, 'nope', uuid(7)]) {
    bodies.push({ ...base, componentId })
  }
  for (const amount of [undefined, null, 42, '', ' ', 'abc', '1.23456', '1,234.56', '12,34', '$5', '1.5E+05', '100.00', 100]) {
    bodies.push({ ...base, amount })
  }
  for (const hours of [undefined, null, '', ' ', 'abc', '1.234', '-3', '-0', '12345678901', '1234567890', '7.5', 7.5, 0, false]) {
    bodies.push({ ...base, hours })
  }
  for (const note of [undefined, null, 42, '', 'x'.repeat(500), 'x'.repeat(501)]) {
    bodies.push({ ...base, note })
  }
  for (const replaceComponent of [undefined, null, true, false, 'yes', 1, 0]) {
    bodies.push({ ...base, replaceComponent })
  }
  // Two faults at once: still refused (the old disjunction refused too).
  bodies.push({ ...base, employeePartyId: 'nope', amount: 'abc' })
  for (const body of bodies) {
    const expected = oldAddRefuses(body)
    const { refused: actual, error } = await refused(body)
    assert.equal(actual, expected, `add-adjustment ${JSON.stringify(body)}: old=${expected} new=${actual}`)
    if (actual) assert.notEqual(error, 'invalid adjustment', `literal survived for ${JSON.stringify(body)}`)
  }
})

test('PARITY delete-adjustment: old guard and new causes agree on every input', async () => {
  for (const adjustmentId of [undefined, null, 42, 'nope', '', uuid(9)]) {
    const body = { action: 'delete-adjustment', adjustmentId }
    const expected = oldDeleteRefuses(body)
    const { refused: actual, error } = await refused(body)
    assert.equal(actual, expected, `delete-adjustment ${JSON.stringify(body)}: old=${expected} new=${actual}`)
    if (actual) assert.notEqual(error, 'invalid adjustment', `literal survived for ${JSON.stringify(body)}`)
  }
})

test('PARITY set-scope: old guard and new causes agree on every input', async () => {
  const twoThousand = Array.from({ length: 2000 }, (_, i) => uuid(i + 1))
  const overLimit = [...twoThousand, uuid(2001)]
  const bodies: Record<string, unknown>[] = [
    validScope(),
    validScope({ employeePartyIds: undefined }),
    validScope({ employeePartyIds: null }),
    validScope({ employeePartyIds: 'nope' }),
    validScope({ employeePartyIds: [] }),
    validScope({ employeePartyIds: [uuid(1), 'nope'] }),
    validScope({ employeePartyIds: [42] }),
    validScope({ rosterPartyIds: undefined }),
    validScope({ rosterPartyIds: null }),
    validScope({ rosterPartyIds: 'x' }),
    validScope({ rosterPartyIds: [] }),
    validScope({ rosterPartyIds: [uuid(1), 'nope'] }),
    validScope({ employeePartyIds: [], rosterPartyIds: [] }),
    validScope({ employeePartyIds: twoThousand.slice(0, 1), rosterPartyIds: twoThousand }),
    validScope({ employeePartyIds: [twoThousand[0]], rosterPartyIds: overLimit }),
    validScope({ employeePartyIds: ['nope'], rosterPartyIds: ['also-bad'] }),
  ]
  for (const body of bodies) {
    const expected = oldScopeRefuses(body)
    const { refused: actual, error } = await refused(body)
    assert.equal(actual, expected, `set-scope ${JSON.stringify(body).slice(0, 120)}: old=${expected} new=${actual}`)
    if (actual) assert.notEqual(error, 'invalid scope', 'literal survived')
  }
})

test('PARITY exclude/include-employee: old guard and new causes agree on every input', async () => {
  for (const action of ['exclude-employee', 'include-employee']) {
    for (const employeePartyId of [undefined, null, 42, 'nope', '', uuid(1)]) {
      const body = { action, employeePartyId }
      const expected = oldEmployeeRefuses(body)
      const { refused: actual, error } = await refused(body)
      assert.equal(actual, expected, `${action} ${JSON.stringify(body)}: old=${expected} new=${actual}`)
      if (actual) assert.notEqual(error, 'invalid employee', `literal survived for ${JSON.stringify(body)}`)
    }
  }
})

