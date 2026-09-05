import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite: the real document-revision primitives fence the
// payments autosave end to end against a scripted database fake — the same
// harness as /api/journals/[id] and /api/expenses/[id].
const stateKey = Symbol.for('openbooks.payment-route-test')
interface RouteState {
  calls: { kind: 'execute' | 'tx-execute'; text: string }[]
  updates: { id: string; patch: Record<string, unknown>; options: unknown }[]
  report: { doc: Record<string, unknown>; bankAccountId: string | null; allocations: unknown[]; applied: unknown[] } | null
  failUpdateWith?: Error
  conflictError?: new () => Error
  respondExecute: (text: string) => { rows: unknown[] }
}
const routeState: RouteState = {
  calls: [],
  updates: [],
  report: null,
  respondExecute: () => ({ rows: [] }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into its raw text for routing scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextPayment?: unknown }).openbooksSqlTextPayment = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payment-route-test')]
      const sqlText = globalThis.openbooksSqlTextPayment
      export const db = {
        execute: (query) => {
          const text = sqlText(query)
          state.calls.push({ kind: 'execute', text })
          return Promise.resolve(state.respondExecute(text))
        },
        transaction: async (work) => work({}),
      }
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
    'mock:payments-engine',
    `
      const state = globalThis[Symbol.for('openbooks.payment-route-test')]
      export class PaymentError extends Error {}
      export class PaymentRevisionConflictError extends PaymentError {
        constructor() {
          super('this payment changed after you opened it; reload and review the latest revision')
          this.name = 'PaymentRevisionConflictError'
        }
      }
      state.conflictError = PaymentRevisionConflictError
      export async function loadPaymentDocument(id, _kind, _orgId) {
        return state.report
      }
      export async function updateDraftPayment(id, patch, _userId, _orgId, options) {
        state.updates.push({ id, patch, options })
        if (state.failUpdateWith) throw state.failUpdateWith
        return state.report
      }
    `,
  ],
  [
    'mock:document-delete',
    `
      export class DeleteError extends Error {}
      export async function deleteDocument() {}
    `,
  ],
  [
    'mock:posting',
    `
      export class PostingError extends Error {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function getAuthz() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function can(_authz, _permission) { return true }
      // Org-wide scope (null): every subsidiary is visible.
      export function guardSubsidiaryScope(_authz, _subsidiaryId) { return null }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payments.ts', 'mock:payments-engine'],
  ['@openbooks/engine/src/document-delete.ts', 'mock:document-delete'],
  ['@openbooks/engine/src/posting.ts', 'mock:posting'],
  ['../../../../lib/authz', 'mock:authz'],
  ['@/lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/payment-run-access') return { shortCircuit: true, url: 'data:text/javascript,export function paymentRunScopeSql(){throw new Error("run scope is outside this document-route unit test")}' }

    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as documents.test.ts).
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payment-occ-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const STORED_REVISION = '2026-08-24T12:00:00.300001Z'
const PAYMENT_ID = '00000000-0000-4000-8000-00000000a001'
const PARTY_ID = '00000000-0000-4000-8000-00000000a002'
const BANK_ID = '00000000-0000-4000-8000-00000000a003'

function reset(): void {
  routeState.calls.length = 0
  routeState.updates.length = 0
  routeState.report = null
  routeState.failUpdateWith = undefined
  routeState.respondExecute = (text) =>
    text.includes('to_char')
      ? { rows: [{ updatedAt: STORED_REVISION }] }
      : { rows: [{ kind: 'vendor_payment', subsidiaryId: null }] }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/payments/${PAYMENT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PAYMENT_ID }) },
  )
}

test('PATCH refuses a save without a revision token before reaching the engine', async () => {
  reset()

  const response = await patch({ memo: 'no token' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the document revision is required; reload and review the latest revision',
  })
  assert.deepEqual(routeState.updates, [], 'the fenced save never reached the engine')
})

test('PATCH saves under an exact matching revision and hands the token to the engine', async () => {
  reset()
  routeState.report = { doc: { id: PAYMENT_ID, updated_at: STORED_REVISION }, bankAccountId: null, allocations: [], applied: [] }

  const response = await patch({
    expectedUpdatedAt: STORED_REVISION,
    partyId: PARTY_ID,
    bankAccountId: BANK_ID,
    memo: 'fenced save',
    allocations: [{
      openLineId: BANK_ID,
      sourceTransactionAmount: '10.00',
      targetTransactionAmount: '10.00',
      settlementRate: '1',
      settlementRateSource: 'same_currency',
      settlementRateReference: 'same transaction currency',
    }],
  })

  assert.equal(response.status, 200)
  // The engine performs the authoritative lock + compare inside its write
  // transaction; the route hands over the caller's exact token untouched.
  assert.equal(routeState.updates.length, 1)
  assert.equal(routeState.updates[0]!.id, PAYMENT_ID)
  assert.deepEqual(routeState.updates[0]!.options, { expectedRevision: STORED_REVISION })
  assert.equal(
    (routeState.updates[0]!.patch as Record<string, unknown>).expectedUpdatedAt,
    undefined,
    'the OCC token never enters the financial patch shape',
  )
  const payload = (await response.json()) as { doc: { updated_at: string } }
  assert.equal(payload.doc.updated_at, STORED_REVISION, 'the caller can chain the next exact save')
})

test('PATCH maps a lost revision race to a 409 conflict without masking the cause', async () => {
  reset()
  routeState.report = { doc: { id: PAYMENT_ID, updated_at: STORED_REVISION }, bankAccountId: null, allocations: [], applied: [] }
  routeState.failUpdateWith = new routeState.conflictError!()

  const response = await patch({
    expectedUpdatedAt: STORED_REVISION,
    memo: 'stale save',
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this payment changed after you opened it; reload and review the latest revision',
  })
})

test('GET exposes the exact persisted revision so callers can fence their next save', async () => {
  reset()
  routeState.report = {
    doc: { id: PAYMENT_ID, updated_at: STORED_REVISION },
    bankAccountId: null,
    allocations: [],
    applied: [],
  }

  const response = await GET(
    new Request(`http://openbooks.test/api/payments/${PAYMENT_ID}`),
    { params: Promise.resolve({ id: PAYMENT_ID }) },
  )

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { doc: { updated_at: string } }
  // Values and the exact revision arrive from the same service snapshot.
  assert.equal(payload.doc.updated_at, STORED_REVISION)
})
