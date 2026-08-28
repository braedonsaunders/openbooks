import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'
import { cmp as compareMoney, normalizeMoney } from '../../../../../../engine/src/money.ts'

interface RouteState {
  permissions: Set<string>
  permissionChecks: string[]
  databaseCalls: string[]
  committedQueries: string[]
  pendingQueries: string[]
  priorCategories: unknown[]
  inTransaction: boolean
  transactions: number
  commits: number
  rollbacks: number
}

const stateKey = Symbol.for('openbooks.cashflow-categories-route-test')
const state: RouteState = {
  permissions: new Set(),
  permissionChecks: [],
  databaseCalls: [],
  committedQueries: [],
  pendingQueries: [],
  priorCategories: [],
  inTransaction: false,
  transactions: 0,
  commits: 0,
  rollbacks: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCashflowCategoriesNextResponse =
  NextResponse

/** Flatten a drizzle SQL chunk into its raw text, including bound values. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCashflowCategoriesSqlText =
  sqlText
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCashflowMoney = {
  compareMoney,
  normalizeMoney,
}

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.cashflow-categories-route-test')]
      const NextResponse = globalThis.openbooksCashflowCategoriesNextResponse
      export async function guardPermission(permission) {
        state.permissionChecks.push(permission)
        if (!state.permissions.has(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.cashflow-categories-route-test')]
      const sqlText = globalThis.openbooksCashflowCategoriesSqlText
      const execute = async (query) => {
        const text = sqlText(query)
        state.databaseCalls.push(text)
        if (state.inTransaction) state.pendingQueries.push(text)
        else state.committedQueries.push(text)
        if (text.includes('select settings')) return { rows: [{ cats: state.priorCategories }] }
        return { rows: [] }
      }
      export const db = {
        execute,
        async transaction(work) {
          state.transactions += 1
          state.inTransaction = true
          state.pendingQueries = []
          try {
            const result = await work({ execute })
            state.committedQueries.push(...state.pendingQueries)
            state.commits += 1
            return result
          } catch (error) {
            state.rollbacks += 1
            throw error
          } finally {
            state.inTransaction = false
            state.pendingQueries = []
          }
        },
      }
    `,
  ],
  [
    'mock:money',
    `
      const money = globalThis.openbooksCashflowMoney
      export const cmp = money.compareMoney
      export const normalizeMoney = money.normalizeMoney
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const routeUrl = './route.ts?cashflow-categories-route-test'
const { PUT } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.permissions = new Set(['admin.setup.manage'])
  state.permissionChecks.length = 0
  state.databaseCalls.length = 0
  state.committedQueries.length = 0
  state.pendingQueries.length = 0
  state.priorCategories = [
    {
      id: 'category-old',
      name: 'Old forecast',
      direction: 'outflow',
      method: 'manual_recurring',
      amount: '500.0000',
      frequency: 'monthly',
    },
  ]
  state.inTransaction = false
  state.transactions = 0
  state.commits = 0
  state.rollbacks = 0
}

function put(categories: unknown[]): Promise<Response> {
  return PUT(
    new Request('http://openbooks.test/api/analytics/cashflow/categories', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categories }),
    }),
  )
}

const validCategory = {
  id: 'category-rent',
  name: 'Rent',
  direction: 'outflow',
  method: 'manual_recurring',
  amount: 1250,
  frequency: 'monthly',
}

const expectedValidCategory = {
  ...validCategory,
  amount: '1250.0000',
}

const fractionalCategory = {
  id: 'category-fractional',
  name: 'Fractional charge',
  direction: 'outflow',
  method: 'manual_recurring',
  amount: '12.3456',
  frequency: 'monthly',
}

const cappedCategory = {
  id: 'category-capped',
  name: 'Large reserve',
  direction: 'inflow',
  method: 'manual_recurring',
  // A string keeps this value exact instead of rounding it through an unsafe
  // JavaScript number before the route applies its configured cap.
  amount: '9007199254740993.0000',
  frequency: 'monthly',
}

test('replacement rejects malformed entries atomically instead of dropping them', async () => {
  reset()

  const response = await put([
    validCategory,
    {
      id: 'category-invalid',
      name: 'Missing amount',
      direction: 'outflow',
      method: 'manual_recurring',
      amount: '12.34567',
    },
  ])

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 1',
    message: 'Each category must include a valid name, method, and method-specific configuration.',
  })
  assert.equal(state.databaseCalls.length, 0, 'invalid replacement never reaches persistence')
  assert.equal(state.transactions, 0, 'invalid replacement never opens a transaction')
  assert.equal(state.committedQueries.length, 0, 'invalid replacement creates no audit or write')
  assert.deepEqual(state.permissionChecks, ['admin.setup.manage'])
})

test('replacement persists every valid row with exact money and complete audit evidence', async () => {
  reset()

  const response = await put([validCategory, fractionalCategory, cappedCategory])

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    categories: [
      expectedValidCategory,
      fractionalCategory,
      { ...cappedCategory, amount: '100000000.0000' },
    ],
  })
  assert.equal(state.transactions, 1)
  assert.equal(state.commits, 1)
  assert.equal(state.rollbacks, 0)
  assert.equal(state.committedQueries.length, 3, 'row lock, replacement, and audit commit together')
  assert.match(state.committedQueries[0]!, /select settings[\s\S]*for update/i)
  assert.match(state.committedQueries[1]!, /update orgs/i)
  const audit = state.committedQueries[2]
  assert.ok(audit, 'the replacement writes an audit row')
  assert.match(audit, /insert into audit_log/i)
  assert.match(audit, /"before":\{"analytics":\{"cashflowCategories":\[\{"id":"category-old"/)
  assert.match(audit, /"after":\{"analytics":\{"cashflowCategories":\[/)
  assert.match(audit, /category-rent/)
  assert.match(audit, /category-fractional/)
  assert.match(audit, /"amount":"12\.3456"/)
  assert.match(audit, /category-capped/)
  assert.match(audit, /"amount":"100000000\.0000"/)
})
