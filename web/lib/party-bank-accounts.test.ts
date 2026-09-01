import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary regression coverage: PostgreSQL timestamptz keeps six
// fractional digits while node-postgres Date values keep only milliseconds.
// The scripted database fake makes the exact revision projection and CAS
// parameter visible without needing a second database session.
const stateKey = Symbol.for('openbooks.party-bank-accounts-route-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface RouteState { calls: DbCall[] }
const routeState: RouteState = { calls: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlText?: unknown }).openbooksSqlText = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const PARTY_ID = '00000000-0000-4000-8000-00000000c001'
const ACCOUNT_ID = '00000000-0000-4000-8000-00000000d001'
const EXACT_REVISION = '2026-08-28T12:34:56.123456Z'
const MILLISECOND_REVISION = '2026-08-28T12:34:56.123Z'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.party-bank-accounts-route-test')]
      const sqlText = globalThis.openbooksSqlText
      function respond(kind, query) {
        const text = sqlText(query)
        state.calls.push({ kind, text })
        if (text.includes('from parties')) return { rows: [{ subsidiaryId: null }] }
        if (text.includes('select approval_status')) {
          return { rows: [{ approvalStatus: 'approved', updatedAt: '${EXACT_REVISION}' }] }
        }
        if (text.includes('from party_bank_accounts') && !text.includes('update party_bank_accounts')) {
          return { rows: [{ updatedAt: '${EXACT_REVISION}' }] }
        }
        if (text.includes('update party_bank_accounts')) return { rows: [{ id: '${ACCOUNT_ID}' }] }
        return { rows: [] }
      }
      export const db = {
        execute: (query) => Promise.resolve(respond('execute', query)),
        transaction: async (work) => work({ execute: (query) => Promise.resolve(respond('tx-execute', query)) }),
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { id: 'user-1', orgId: '${ORG_ID}' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  ['mock:payments', `export function encryptAccountNumber(value) { return 'encrypted:' + value }`],
  ['mock:flows', `export async function runRecordFlows() { return { runs: [], gatesCreated: 0, failed: false } }`],
  ['mock:bank-adapter', `export const BANK_ACCOUNT_SUBJECT_KIND = 'party_bank_account'`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payments.ts', 'mock:payments'],
  ['@openbooks/engine/src/flows/run.ts', 'mock:flows'],
  ['@openbooks/engine/src/flows/bank-accounts-adapter.ts', 'mock:bank-adapter'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`./${specifier.slice('@/lib/'.length)}.ts`, import.meta.url).href, context)
    }
    if (specifier.endsWith('/lib/authz')) return { url: 'mock:authz', shortCircuit: true }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = '../app/api/parties/[id]/bank-accounts/route.ts?party-bank-accounts-occ-test'
const { PATCH, DELETE } = (await import(routeUrl)) as typeof import('../app/api/parties/[id]/bank-accounts/route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
}

function patch(expectedUpdatedAt: string): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Updated bank', expectedUpdatedAt, changeReason: 'corrected account detail' }),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

function retire(expectedUpdatedAt: string): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt, retirementReason: 'account no longer used' }),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

test('PATCH accepts the exact six-digit revision and binds it as timestamptz', async () => {
  reset()
  const response = await patch(EXACT_REVISION)

  assert.equal(response.status, 200)
  const select = routeState.calls.find((call) => call.text.includes('select approval_status'))
  assert.ok(select)
  assert.match(select.text, /to_char\([\s\S]*HH24:MI:SS\.US/)
  const update = routeState.calls.find((call) => call.text.includes('update party_bank_accounts'))
  assert.ok(update)
  assert.match(update.text, /updated_at = [\s\S]*::timestamptz/)
})

test('PATCH rejects a millisecond-truncated revision before any write', async () => {
  reset()
  const response = await patch(MILLISECOND_REVISION)

  assert.equal(response.status, 409)
  assert.ok(!routeState.calls.some((call) => call.text.includes('update party_bank_accounts')))
})

test('DELETE binds the exact retirement revision as timestamptz', async () => {
  reset()
  const response = await retire(EXACT_REVISION)

  assert.equal(response.status, 200)
  const update = routeState.calls.find((call) => call.text.includes('update party_bank_accounts'))
  assert.ok(update)
  assert.match(update.text, /updated_at = [\s\S]*::timestamptz/)
})
