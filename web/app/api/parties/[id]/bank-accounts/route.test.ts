import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.bank-accounts-route-test')
const PARTY_ID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const EXACT_REVISION = '2026-08-31T12:34:56.789123Z'
const TRUNCATED_REVISION = '2026-08-31T12:34:56.789Z'

interface RouteState {
  queries: string[]
  updateParams: unknown[][]
  existingUpdatedAt: string
}

const state: RouteState = {
  queries: [],
  updateParams: [],
  existingUpdatedAt: EXACT_REVISION,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function queryText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return ''
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return queryText(chunk)
      return ''
    })
    .join('')
}

;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlText = queryText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
      const sqlText = globalThis.openbooksSqlText
      function params(query) {
        return (query.queryChunks ?? []).filter((chunk) => chunk === null || typeof chunk !== 'object')
      }
      function respond(query) {
        const text = sqlText(query)
        state.queries.push(text)
        if (text.includes('from parties')) return { rows: [{ subsidiaryId: null }] }
        if (text.includes('select approval_status')) return { rows: [{ approvalStatus: 'approved', updatedAt: state.existingUpdatedAt }] }
        if (text.includes('from payment_instructions')) return { rows: [{ inFlightPayment: false }] }
        if (text.includes('from payment_mandates')) return { rows: [{ in_flight_payment: false, live_mandate: false }] }
        if (text.includes('update party_bank_accounts')) {
          state.updateParams.push(params(query))
          return { rows: [{ id: 'account-1' }] }
        }
        if (text.includes('insert into audit_log')) return { rows: [] }
        if (text.includes('update flow_gates') || text.includes('update flow_runs')) return { rows: [] }
        throw new Error('unexpected database query: ' + text)
      }
      export const db = {
        execute: async (query) => respond(query),
        transaction: async (work) => work({ execute: async (query) => respond(query) }),
      }
      export function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  ['mock:list-params', `export function isUuid(value) { return typeof value === 'string' && value.length > 0 }`],
  [
    'mock:countries',
    `
      export function normalizeCountryCode(value) {
        if (typeof value !== 'string') return null
        const normalized = value.trim().toUpperCase()
        return normalized.length === 2 ? normalized : null
      }
    `,
  ],
  ['mock:payments', `export function encryptAccountNumber(value) { return 'encrypted:' + value }`],
  ['mock:flows', `export async function runRecordFlows() { return { failed: false } }`],
  ['mock:bank-adapter', `export const BANK_ACCOUNT_SUBJECT_KIND = 'party_bank_account'`],
  ['mock:documents', `export function documentRevisionSql(column) { return column }`],
  [
    'mock:registry-data',
    `export function isDocumentRevisionToken(value) { return typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$/.test(value) }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/features', 'mock:features'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../lib/countries', 'mock:countries'],
  ['@openbooks/engine/src/payments.ts', 'mock:payments'],
  ['@openbooks/engine/src/flows/run.ts', 'mock:flows'],
  ['@openbooks/engine/src/flows/bank-accounts-adapter.ts', 'mock:bank-adapter'],
  ['../../../../../lib/documents', 'mock:documents'],
  ['../../../../../lib/api/registry-data', 'mock:registry-data'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', shortCircuit: true, url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:json') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const jsonObject = {}
          export async function parseJsonBody(req) { return { ok: true, data: await req.json() } }
        `,
      }
    }
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?bank-accounts-safeguard-test'
const { PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.queries.length = 0
  state.updateParams.length = 0
  state.existingUpdatedAt = EXACT_REVISION
}

function request(method: 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<Response> {
  return (method === 'PATCH' ? PATCH : DELETE)(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

test('PATCH rejects a normalized account number shorter than four characters', async () => {
  reset()
  const response = await request('PATCH', {
    accountNumber: ' 12 ',
    changeReason: 'replace account',
    expectedUpdatedAt: EXACT_REVISION,
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'accountNumber required' })
  assert.equal(state.updateParams.length, 0)
})

test('PATCH accepts a valid account update with a canonical revision', async () => {
  reset()
  const response = await request('PATCH', {
    accountNumber: '987654321',
    changeReason: 'replace account',
    expectedUpdatedAt: EXACT_REVISION,
  })

  assert.equal(response.status, 200)
  assert.equal(state.updateParams.length, 1)
  assert.ok(state.updateParams[0]?.includes('4321'))
  assert.match(state.queries.find((query) => query.includes('update party_bank_accounts')) ?? '', /::timestamptz/)
})

test('PATCH rejects a millisecond-truncated revision before touching the row', async () => {
  reset()
  const response = await request('PATCH', {
    bankName: 'Updated bank',
    changeReason: 'replace account',
    expectedUpdatedAt: TRUNCATED_REVISION,
  })

  assert.equal(response.status, 409)
  assert.equal(state.updateParams.length, 0)
})

test('DELETE requires the same canonical revision format as PATCH', async () => {
  reset()
  const response = await request('DELETE', {
    retirementReason: 'account retired',
    expectedUpdatedAt: '2026-08-31T08:34:56.789123-04:00',
  })

  assert.equal(response.status, 409)
  assert.equal(state.updateParams.length, 0)
})

test('DELETE accepts the canonical revision and binds it as timestamptz', async () => {
  reset()
  const response = await request('DELETE', {
    retirementReason: 'account retired',
    expectedUpdatedAt: EXACT_REVISION,
  })

  assert.equal(response.status, 200)
  assert.equal(state.updateParams.length, 1)
  assert.match(state.queries.find((query) => query.includes('update party_bank_accounts')) ?? '', /::timestamptz/)
})
