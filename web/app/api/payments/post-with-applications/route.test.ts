import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.payment-post-route-test')
type State = {
  status: 'draft' | 'approved'
  events: string[]
  postError?: string
  staleRevision: string
  updateOptions?: { expectedRevision?: string }
}
const state: State = { status: 'draft', events: [], staleRevision: '2026-08-23T11:00:00.100001Z' }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mocks = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export const db = { execute: async (query) => ({ rows: [{ kind: 'vendor_payment', status: state.status, subsidiaryId: null }] }) }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:payments',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export class PaymentError extends Error {}
      export class PaymentRevisionConflictError extends PaymentError {}
      export async function updateDraftPayment(id, patch, userId, orgId, options) {
        state.events.push('update')
        state.updateOptions = options
        if (options?.expectedRevision === state.staleRevision) {
          throw new PaymentRevisionConflictError('this document changed after you opened it; reload and review the latest revision')
        }
      }
      export async function postPaymentWithApplications() {
        state.events.push('post')
        if (state.postError) throw new PaymentError(state.postError)
        return { entryId: 'entry-1' }
      }
    `,
  ],
  [
    'mock:flows',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export async function submitAndReleaseIfUngated() {
        state.events.push('submit')
        return { gated: false, flowError: null, runId: null, autoApproved: true }
      }
      export async function runRecordFlows() { return null }
    `,
  ],
  [
    'mock:posting',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export class PostingError extends Error {}
      export async function runPostDocumentEffects() { state.events.push('effects') }
    `,
  ],
  [
    'mock:authz',
    `
      export async function getAuthz() { return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null } }
      export function can() { return true }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/payment-run-access') return { shortCircuit: true, url: 'data:text/javascript,export function paymentRunScopeSql(){throw new Error("run scope is outside this document-route unit test")}' }

    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = new Map<string, string>([
      ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
      ['@openbooks/engine/src/payments/payment-accounts.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-contracts.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-documents.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-errors.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-posting.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-queries.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/payment-return.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/rail-cpa005.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/rail-nacha.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/rail-sepa.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/rail-cemtex.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/rail-settings.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/run-cancellation.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/run-creation.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/run-files.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/run-posting.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/run-readiness.ts', 'mock:payments'],
  ['@openbooks/engine/src/payments/settlement-policy.ts', 'mock:payments'],
      ['@openbooks/engine/src/flows/index.ts', 'mock:flows'],
      ['@openbooks/engine/src/ledger/posting-accounts.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-contracts.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-dispatch.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-document.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-invariants.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-projection.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-provider-tax.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-replay.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-rules.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-subsidiaries.ts', 'mock:posting'],
  ['@openbooks/engine/src/ledger/posting-tax-policy.ts', 'mock:posting'],
      ['../../../../lib/authz', 'mock:authz'],
      ['@/lib/authz', 'mock:authz'],
    ]).get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payment-post-boundary-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const allocation = {
  openLineId: 'line-1',
  sourceTransactionAmount: '10.00',
  targetTransactionAmount: '10.00',
  settlementRate: '1',
  settlementRateSource: 'same_currency',
  settlementRateReference: 'same transaction currency',
}

const VALID_REVISION = '2026-08-24T12:00:00.300001Z'

function request(body: unknown): Request {
  return new Request('http://openbooks.test/api/payments/post-with-applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('draft posting persists final allocations before approval and posting', async () => {
  state.status = 'draft'
  state.events.length = 0
  state.postError = undefined
  state.updateOptions = undefined

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: VALID_REVISION, allocations: [allocation] }))

  assert.equal(response.status, 200)
  assert.deepEqual(state.events, ['update', 'submit', 'post', 'effects'])
  assert.deepEqual(state.updateOptions, { expectedRevision: VALID_REVISION })
})

test('draft posting without a revision token is rejected as a 409 before any engine write', async () => {
  state.status = 'draft'
  state.events.length = 0
  state.postError = undefined
  state.updateOptions = undefined

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', allocations: [allocation] }))

  assert.equal(response.status, 409)
  assert.deepEqual(state.events, [], 'no draft save, submit, or posting may run without concurrency evidence')
})

test('draft posting with a malformed revision token is rejected as a 409', async () => {
  state.status = 'draft'
  state.events.length = 0
  state.postError = undefined

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: 'yesterday', allocations: [allocation] }))

  assert.equal(response.status, 409)
  assert.deepEqual(state.events, [])
})

test('draft posting with a stale revision token surfaces the engine fence as a 409', async () => {
  state.status = 'draft'
  state.events.length = 0
  state.postError = undefined

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: state.staleRevision, allocations: [allocation] }))

  assert.equal(response.status, 409)
  assert.deepEqual(state.events, ['update'], 'the fenced save fired and nothing downstream ran')
})

test('approved posting errors are returned without an unapproved allocation save', async () => {
  state.status = 'approved'
  state.events.length = 0
  state.postError = 'payment allocations differ from the approved document'

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', expectedUpdatedAt: VALID_REVISION, allocations: [allocation] }))

  assert.equal(response.status, 422)
  assert.deepEqual(state.events, ['post'])
  state.postError = undefined
})
