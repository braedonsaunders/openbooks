import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * POST submit-approval — the remedy the commit refusal names.
 *
 * The wizard had no submit affordance: `submit-approval` existed only as an
 * API action, so a pure-UI operator on an org with a pay-run approval flow
 * was permanently stuck past Commit. The boundary here is unchanged (the
 * commit refusal's CONDITIONS do not move); this file proves the adapter
 * around it: submit assembles the evidence package and routes through the
 * native Flows engine, a tenant with no flow reports `gated: false` with the
 * document untouched, a flow error fails closed, and commit still refuses
 * through the same approval boundary as before.
 */

const stateKey = Symbol.for('openbooks.payroll-run-submit-approval-test')
interface RouteState {
  ownedSubsidiaryId: string | null
  submitCalls: unknown[][]
  submitResult: { gated: boolean; runId: string | null; flowError: string | null }
  evidenceCalls: unknown[][]
  approvalReleaseCalls: unknown[]
  approvalReleaseError: string | null
  commitCalls: unknown[]
}
const routeState: RouteState = {
  ownedSubsidiaryId: 'sub-1',
  submitCalls: [],
  submitResult: { gated: true, runId: 'run-1', flowError: null },
  evidenceCalls: [],
  approvalReleaseCalls: [],
  approvalReleaseError: null,
  commitCalls: [],
}
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-submit-approval-test')]
      export const db = {
        execute() { return Promise.resolve({ rows: state.ownedSubsidiaryId ? [{ subsidiaryId: state.ownedSubsidiaryId }] : [] }) },
      }
      export async function withOrgTransaction(_orgId, fn) { return fn() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
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
      const state = globalThis[Symbol.for('openbooks.payroll-run-submit-approval-test')]
      export async function acknowledgePayRunRefusals() { throw new Error('not under test') }
      export async function calculatePayRun() { throw new Error('not under test') }
      export async function commitPayRun(input) { state.commitCalls.push(input); return { ok: true, lines: 1 } }
      export async function discardPayRun() { throw new Error('not under test') }
      export async function previewPayRunGl() { throw new Error('not under test') }
    `,
  ],
  ['mock:payroll-payment', `export async function recordPayRunPayment() { throw new Error('not under test') }`],
  ['mock:payroll-readiness', `export async function assertPayRunNotStale() {}`],
  [
    'mock:payroll-approval',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-submit-approval-test')]
      // The boundary maps the REAL PayrollError to 422, so the double must
      // raise the real class — resolved to a file URL because a mock: URL
      // has no base for workspace resolution (see the resolve hook below).
      const { PayrollError } = await import('real:payroll-error')
      export async function assertPayRunApprovalReleased(orgId, documentId) {
        state.approvalReleaseCalls.push({ orgId, documentId })
        if (state.approvalReleaseError) throw new PayrollError(state.approvalReleaseError)
      }
      export async function payRunApprovalState() { throw new Error('not under test') }
    `,
  ],
  [
    'mock:flows',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-submit-approval-test')]
      export async function submitForApproval(...args) {
        state.submitCalls.push(args)
        return { ...state.submitResult }
      }
    `,
  ],
  ['mock:payroll-outputs', `export async function emailRunStubs() { throw new Error('not under test') }`],
  [
    'mock:payroll-evidence',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-submit-approval-test')]
      export async function assemblePayRunEvidence(...args) {
        state.evidenceCalls.push(args)
        return { attached: 3 }
      }
    `,
  ],
  ['mock:payroll-scope', `export async function lockAndCheckPayrollRunPopulation() { throw new Error('not under test') }`],
  [
    'mock:payroll-run-adjustments',
    `
      export function canonicalAdjustmentHours() { throw new Error('not under test') }
      export async function mutatePayRunAdjustment() { throw new Error('not under test') }
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
    // A mock: URL has no base for workspace resolution; the approval double
    // raises the REAL PayrollError (the boundary maps it to 422 by
    // instanceof), so resolve it to the workspace file explicitly.
    if (specifier === 'real:payroll-error') {
      return {
        shortCircuit: true,
        url: new URL('../../../../../../engine/src/payroll/error.ts', import.meta.url).href,
      }
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

const routeUrl = './route.ts?payroll-run-submit-approval-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const RUN_ID = '00000000-0000-4000-8000-000000000001'

function reset() {
  routeState.ownedSubsidiaryId = 'sub-1'
  routeState.submitCalls = []
  routeState.submitResult = { gated: true, runId: 'run-1', flowError: null }
  routeState.evidenceCalls = []
  routeState.approvalReleaseCalls = []
  routeState.approvalReleaseError = null
  routeState.commitCalls = []
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

test('submit-approval assembles the evidence package and routes through the native engine', async () => {
  reset()
  const res = await post({ action: 'submit-approval' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, evidence: { attached: 3 }, gated: true })
  // Evidence first (the approver reads it), then the Flows submission with
  // the pay_run subject kind — payroll models nothing itself.
  assert.deepEqual(routeState.evidenceCalls, [['org-1', 'actor-1', RUN_ID, null]])
  assert.deepEqual(routeState.submitCalls, [['pay_run', RUN_ID, 'actor-1']])
})

test('submit-approval on a tenant with no flow reports gated:false and parks nothing', async () => {
  reset()
  routeState.submitResult = { gated: false, runId: null, flowError: null }
  const res = await post({ action: 'submit-approval' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, evidence: { attached: 3 }, gated: false })
})

test('submit-approval fails closed when the flow errors', async () => {
  reset()
  routeState.submitResult = { gated: false, runId: null, flowError: 'approval could not be routed: no approvers resolved' }
  const res = await post({ action: 'submit-approval' })
  assert.equal(res.status, 422)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /no approvers resolved/)
  assert.equal(routeState.commitCalls.length, 0)
})

test('commit still refuses through the unchanged approval boundary', async () => {
  reset()
  routeState.approvalReleaseError =
    'pay run has not been submitted for approval — this organization requires a pay-run approval'
  const res = await post({ action: 'commit' })
  assert.equal(res.status, 422)
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, routeState.approvalReleaseError)
  // The refusal fired before any money moved.
  assert.equal(routeState.commitCalls.length, 0)
  assert.deepEqual(routeState.approvalReleaseCalls, [{ orgId: 'org-1', documentId: RUN_ID }])
})

test('submit-approval on an unknown run answers not found', async () => {
  reset()
  routeState.ownedSubsidiaryId = null
  const res = await post({ action: 'submit-approval' })
  assert.equal(res.status, 404)
  assert.equal(routeState.submitCalls.length, 0)
})
