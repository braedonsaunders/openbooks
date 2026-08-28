import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.payment-post-route-test')
type State = {
  status: 'draft' | 'approved'
  events: string[]
  postError?: string
}
const state: State = { status: 'draft', events: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mocks = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export const db = { execute: async (query) => ({ rows: [{ kind: 'vendor_payment', status: state.status, subsidiaryId: null }] }) }
      export function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:payments',
    `
      const state = globalThis[Symbol.for('openbooks.payment-post-route-test')]
      export class PaymentError extends Error {}
      export async function updateDraftPayment() { state.events.push('update') }
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
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = new Map<string, string>([
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['@openbooks/engine/src/payments.ts', 'mock:payments'],
      ['@openbooks/engine/src/flows/index.ts', 'mock:flows'],
      ['@openbooks/engine/src/posting.ts', 'mock:posting'],
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

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', allocations: [allocation] }))

  assert.equal(response.status, 200)
  assert.deepEqual(state.events, ['update', 'submit', 'post', 'effects'])
})

test('approved posting errors are returned without an unapproved allocation save', async () => {
  state.status = 'approved'
  state.events.length = 0
  state.postError = 'payment allocations differ from the approved document'

  const response = await POST(request({ documentId: '00000000-0000-4000-8000-000000000001', allocations: [allocation] }))

  assert.equal(response.status, 422)
  assert.deepEqual(state.events, ['post'])
  state.postError = undefined
})
