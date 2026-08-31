import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

const PARTY_ID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const ACTUAL_UPDATED_AT = '2026-08-31T12:34:56.789Z'

interface RouteState {
  operation: 'patch' | 'delete'
  updatedAt: string
  queries: string[]
  updateParams: unknown[][]
  auditCalls: number
  auditParams: unknown[][]
  flowCalls: number
}

const stateKey = Symbol.for('openbooks.bank-accounts-route-test')
const state: RouteState = {
  operation: 'patch',
  updatedAt: ACTUAL_UPDATED_AT,
  queries: [],
  updateParams: [],
  auditCalls: 0,
  auditParams: [],
  flowCalls: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksBankAccountsNextResponse = NextResponse

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

function queryParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return []
  return chunks.filter((chunk) => {
    if (!chunk || typeof chunk !== 'object') return true
    return !('value' in chunk || 'queryChunks' in chunk)
  })
}

const mockSources = new Map<string, string>([
  [
    'json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'authz',
    `
      const NextResponse = globalThis.openbooksBankAccountsNextResponse
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    'features',
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
  [
    'list-params',
    `
      export function isUuid(value) { return typeof value === 'string' && value.length > 0 }
    `,
  ],
  [
    'countries',
    `
      export function normalizeCountryCode(value) {
        if (typeof value !== 'string') return null
        const normalized = value.trim().toUpperCase()
        return normalized.length === 2 ? normalized : null
      }
    `,
  ],
  [
    'payments',
    `
      export function encryptAccountNumber(value) { return 'encrypted:' + value }
    `,
  ],
  [
    'flows',
    `
      const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
      export async function runRecordFlows() { state.flowCalls += 1; return { failed: false } }
    `,
  ],
  [
    'bank-account-adapter',
    `export const BANK_ACCOUNT_SUBJECT_KIND = 'party_bank_account'`,
  ],
  [
    'db',
    `
      const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
      function queryText(query) {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks.map((chunk) => {
          if (typeof chunk === 'string') return ''
          const value = chunk?.value
          if (Array.isArray(value)) return value.map(String).join('')
          if (chunk?.queryChunks) return queryText(chunk)
          return ''
        }).join('')
      }
      function queryParams(query) {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return []
        return chunks.filter((chunk) => {
          if (!chunk || typeof chunk !== 'object') return true
          return !('value' in chunk || 'queryChunks' in chunk)
        })
      }
      export async function withOrgTransaction(_orgId, work) { return work() }
      export const db = {
        async execute(query) {
          const text = queryText(query)
          state.queries.push(text)
          if (text.includes('from parties')) return { rows: [{ subsidiaryId: null }] }
          if (text.includes('select approval_status') && text.includes('from party_bank_accounts')) {
            return { rows: [{ approvalStatus: 'approved', updatedAt: new Date(state.updatedAt) }] }
          }
          if (text.includes('select updated_at') && text.includes('from party_bank_accounts')) {
            return { rows: [{ updatedAt: new Date(state.updatedAt) }] }
          }
          if (text.includes('from payment_instructions') && text.includes('payment_mandates')) {
            return { rows: [{ in_flight_payment: false, live_mandate: false }] }
          }
          if (text.includes('from payment_instructions')) return { rows: [{ inFlightPayment: false }] }
          if (text.includes('update party_bank_accounts')) {
            state.updateParams.push(queryParams(query))
            if (state.operation === 'delete') {
              const timestamp = queryParams(query).find((value) => value instanceof Date)
              if (timestamp instanceof Date && timestamp.getTime() === new Date(state.updatedAt).getTime()) {
                return { rows: [{ id: 'account-1' }] }
              }
              return { rows: [] }
            }
            return { rows: [{ id: 'account-1' }] }
          }
          if (text.includes('insert into audit_log')) {
            state.auditCalls += 1
            state.auditParams.push(queryParams(query))
            return { rows: [] }
          }
          if (text.includes('update flow_gates') || text.includes('update flow_runs')) return { rows: [] }
          throw new Error('unexpected database query: ' + text)
        },
      }
    `,
  ],
])

const selfUrl = new URL(import.meta.url).href
const mockUrl = (name: string) => `${selfUrl}?bank-accounts-mock=${name}`
const mockUrls = new Map<string, string>([
  ['@/lib/api/json', mockUrl('json')],
  ['../../../../../lib/authz', mockUrl('authz')],
  ['../../../../../lib/features', mockUrl('features')],
  ['../../../../../lib/list-params', mockUrl('list-params')],
  ['../../../../../lib/countries', mockUrl('countries')],
  ['@openbooks/engine/src/db.ts', mockUrl('db')],
  ['@openbooks/engine/src/payments.ts', mockUrl('payments')],
  ['@openbooks/engine/src/flows/run.ts', mockUrl('flows')],
  ['@openbooks/engine/src/flows/bank-accounts-adapter.ts', mockUrl('bank-account-adapter')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', shortCircuit: true, url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    if (parsed.searchParams.has('bank-accounts-mock')) {
      const source = mockSources.get(parsed.searchParams.get('bank-accounts-mock') ?? '')
      if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?bank-accounts-route-test'
const { PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(operation: RouteState['operation']): void {
  state.operation = operation
  state.updatedAt = ACTUAL_UPDATED_AT
  state.queries = []
  state.updateParams = []
  state.auditCalls = 0
  state.auditParams = []
  state.flowCalls = 0
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

test('PATCH rejects account numbers shorter than four characters', async () => {
  reset('patch')
  const response = await request('PATCH', {
    accountNumber: '12',
    changeReason: 'replace account',
    expectedUpdatedAt: ACTUAL_UPDATED_AT,
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'accountNumber required' })
  assert.equal(state.updateParams.length, 0)
})

test('PATCH accepts a valid account update and stores its last four digits', async () => {
  reset('patch')
  const response = await request('PATCH', {
    accountNumber: '987654321',
    changeReason: 'replace account',
    expectedUpdatedAt: ACTUAL_UPDATED_AT,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: ACCOUNT_ID,
    approvalStatus: 'pending',
    changedFields: ['accountNumber'],
  })
  assert.equal(state.updateParams.length, 1)
  assert.ok(state.updateParams[0]?.includes('4321'))
  assert.equal(state.auditCalls, 1)
  assert.equal(state.flowCalls, 1)
})

test('DELETE accepts semantically equal timestamp spellings and attributes the retirement', async () => {
  reset('delete')
  const response = await request('DELETE', {
    retirementReason: 'account retired',
    expectedUpdatedAt: '2026-08-31T08:34:56.789-04:00',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(state.updateParams.length, 1)
  assert.ok(state.updateParams[0]?.some((value) => value instanceof Date))
  assert.equal(state.auditCalls, 1)
  assert.ok(state.auditParams[0]?.includes('user-1'))
})

test('DELETE refuses a stale revision before touching the row', async () => {
  reset('delete')
  const response = await request('DELETE', {
    retirementReason: 'account retired',
    expectedUpdatedAt: '2026-08-31T12:34:55.789Z',
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'these bank details changed or were already retired; reload and review the latest revision',
  })
  assert.equal(state.updateParams.length, 0)
  assert.equal(state.auditCalls, 0)
})
