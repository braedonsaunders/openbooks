import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A verify-only user holds the attestation duty (`compliance.verify`) but not
// the editing duty (`compliance.manage`). An unknown `action` value must be
// rejected outright: today it sails through the `compliance.verify` gate and
// falls into the `update` branch, so a verify-only user can rewrite a
// certificate's substance — the exact separation of duties the route comment
// claims to enforce.
const stateKey = Symbol.for('openbooks.compliance-record-action-allowlist-test')

type Certificate = Record<string, unknown>
type DbCall = { kind: 'execute' | 'tx-execute'; text: string; params: string[] }

interface RouteState {
  calls: DbCall[]
  committedRecord: Certificate
  transactions: number
}

const state: RouteState = { calls: [], committedRecord: {}, transactions: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into text for statement routing and assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextComplianceAllow?: unknown }).openbooksSqlTextComplianceAllow = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const VERIFIER_ID = '00000000-0000-4000-8000-00000000b002'
const CREATOR_ID = '00000000-0000-4000-8000-00000000b003'
const RECORD_ID = '00000000-0000-4000-8000-00000000b006'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.compliance-record-action-allowlist-test')]
      const sqlText = globalThis.openbooksSqlTextComplianceAllow
      function respond(kind, query) {
        const text = sqlText(query)
        state.calls.push({ kind, text, params: [] })
        if (text.includes('from compliance_records')) return { rows: [state.committedRecord] }
        if (text.includes('update compliance_records')) {
          state.committedRecord = { ...state.committedRecord, tampered: true }
          return { rows: [] }
        }
        return { rows: [] }
      }
      export const db = {
        execute: (query) => Promise.resolve(respond('execute', query)),
        transaction: async (work) => {
          state.transactions += 1
          return work({ execute: (query) => respond('tx-execute', query) })
        },
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:authz',
    `
      // Verify-only user: attestation duty without the editing duty.
      export async function getAuthz() {
        return { user: { orgId: '${ORG_ID}', id: '${VERIFIER_ID}' }, allowedSubsidiaryIds: null }
      }
      export function can(_authz, perm) { return perm === 'compliance.verify' }
    `,
  ],
  [
    'mock:compliance',
    `
      export async function guardComplianceFeature() { return null }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/authz', 'mock:authz'],
  ['@/lib/compliance', 'mock:compliance'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@/')) {
      return {
        url: new URL(`../../../../../${specifier.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?compliance-record-action-allowlist-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.calls = []
  state.transactions = 0
  // A pending certificate recorded by somebody else (so `verify` is legal).
  state.committedRecord = {
    id: RECORD_ID,
    status: 'pending_review',
    party_id: '00000000-0000-4000-8000-00000000b004',
    requirement_id: '00000000-0000-4000-8000-00000000b005',
    created_by: CREATOR_ID,
    issuer_name: 'Original Insurer',
  }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/compliance/records/${RECORD_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RECORD_ID }) },
  )
}

function updatesAttempted(): boolean {
  return state.calls.some((call) => call.text.includes('update compliance_records'))
}

test('control: a verify-only user cannot use the named update action', async () => {
  reset()
  const response = await patch({ action: 'update', issuerName: 'Evil Insurer' })
  assert.equal(response.status, 403)
  assert.ok(!updatesAttempted(), 'no certificate write may run')
})

test('an unknown action is rejected instead of falling through to update', async () => {
  reset()
  const response = await patch({ action: 'approve_override', issuerName: 'Evil Insurer' })
  assert.equal(response.status, 400)
  const payload = (await response.json()) as { error?: string }
  assert.ok(payload.error, 'the rejection names the problem')
  assert.ok(!updatesAttempted(), 'a verify-only caller must not reach the update branch')
  assert.deepEqual(
    (state.committedRecord as { issuer_name?: string }).issuer_name,
    'Original Insurer',
  )
})
