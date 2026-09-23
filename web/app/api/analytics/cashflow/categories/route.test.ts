import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

interface RouteState {
  permissions: Set<string>
  permissionChecks: string[]
  databaseCalls: string[]
  committedQueries: string[]
  pendingQueries: string[]
  priorCategories: unknown[]
  priorRevision: number
  accounts: Map<string, { type: string; is_summary: boolean; subsidiary_id: string | null }>
  parties: Map<string, { is_vendor: boolean; subsidiary_id: string | null }>
  allowedSubs: Set<string> | null
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
  priorRevision: 0,
  accounts: new Map(),
  parties: new Map(),
  allowedSubs: null,
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

// Neither '@/lib/api/json' nor the money kernel is mocked: validation and
// money are never doubled (a double cannot produce the refusals the real
// modules enforce), and the route's exact-money behavior is what these
// assertions pin.
const mockSources = new Map<string, string>([
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
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.allowedSubs }
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
        if (text.includes('select settings')) return { rows: [{ cats: state.priorCategories, rev: state.priorRevision }] }
        // Reference checks: the double serves exactly the seeded rows, so an
        // unseeded id refuses — a double that always resolves could never
        // produce the refusal under test.
        if (text.includes('from accounts')) return { rows: [...state.accounts].map(([id, row]) => ({ id, ...row })) }
        if (text.includes('from parties')) return { rows: [...state.parties].map(([id, row]) => ({ id, ...row })) }
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
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/authz', 'mock:authz'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real '@/lib/api/json' imports 'server-only', which is inert here.
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
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
const { PUT, GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.permissions = new Set(['admin.setup.manage', 'reports.read'])
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
  state.priorRevision = 7
  state.accounts = new Map()
  state.parties = new Map()
  state.allowedSubs = null
  state.inTransaction = false
  state.transactions = 0
  state.commits = 0
  state.rollbacks = 0
}

function put(categories: unknown[], expectedRevision: unknown = state.priorRevision): Promise<Response> {
  return PUT(
    new Request('http://openbooks.test/api/analytics/cashflow/categories', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categories, expectedRevision }),
    }),
  )
}

const todayAnchor = () => new Date().toISOString().slice(0, 10)

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
  anchorDate: todayAnchor(),
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

test('an over-limit manual amount refuses naming the limit instead of clamping', async () => {
  reset()

  const response = await put([validCategory, cappedCategory])

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 1',
    message: 'manual amount 9007199254740993.0000 exceeds the maximum 100000000.0000',
  })
  assert.equal(state.databaseCalls.length, 0, 'an over-limit replacement never reaches persistence')
  assert.equal(state.transactions, 0, 'an over-limit replacement never opens a transaction')
  assert.equal(state.committedQueries.length, 0, 'an over-limit replacement creates no audit or write')
})

test('replacement persists every valid row with exact money and complete audit evidence', async () => {
  reset()

  const response = await put([validCategory, fractionalCategory])

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    categories: [
      expectedValidCategory,
      { ...fractionalCategory, anchorDate: todayAnchor() },
    ],
    revision: 8,
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
  assert.doesNotMatch(audit, /category-capped/)
})

test('GET returns the list with its revision', async () => {
  reset()
  const response = await GET()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { categories: state.priorCategories, revision: 7 })
})

test('a replacement without the expected revision refuses before touching the database', async () => {
  reset()
  const response = await PUT(
    new Request('http://openbooks.test/api/analytics/cashflow/categories', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categories: [validCategory] }),
    }),
  )
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'expectedRevision required',
    message: 'Send the revision returned by GET with every replacement.',
  })
  assert.equal(state.databaseCalls.length, 0, 'a revision-less replacement never reaches persistence')
  assert.equal(state.transactions, 0, 'a revision-less replacement never opens a transaction')
})

test('a stale replacement gets 409 and writes nothing', async () => {
  reset()
  const response = await put([validCategory], 6)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'revision conflict',
    message: 'Cashflow categories changed since revision 6 (now at 7): reload and reapply your edit.',
    revision: 7,
  })
  assert.equal(state.transactions, 1, 'the conflict is detected on the locked row')
  assert.equal(state.commits, 1, 'detecting the conflict writes nothing to roll back')
  assert.equal(state.committedQueries.length, 1, 'only the locking read commits')
  assert.doesNotMatch(state.committedQueries[0]!, /update orgs/i)
  assert.doesNotMatch(state.committedQueries[0]!, /insert into audit_log/i)
})

const ACCT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PARTY = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const GHOST = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

test('a non-UUID reference refuses before the cast can explode', async () => {
  reset()
  const response = await put([
    {
      id: 'category-gl',
      name: 'GL',
      direction: 'outflow',
      method: 'gl_history_average',
      accountIds: ['not-a-uuid'],
    },
  ])
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 0',
    message: 'accountIds "not-a-uuid" is not a valid UUID',
  })
  assert.equal(state.transactions, 0, 'a malformed reference never opens a transaction')
})

test('an unknown reference refuses naming the field instead of forecasting zero', async () => {
  reset()
  for (const [field, category] of [
    ['accountIds', { id: 'c1', name: 'GL', direction: 'outflow', method: 'gl_history_average', accountIds: [GHOST] }],
    ['partyIds', { id: 'c2', name: 'VP', direction: 'outflow', method: 'vendor_payment_history', partyIds: [GHOST] }],
    ['cardAccountIds', { id: 'c3', name: 'CC', direction: 'outflow', method: 'credit_card_cycle', cardAccountIds: [GHOST] }],
    ['bankAccountIds', { id: 'c4', name: 'BR', direction: 'outflow', method: 'bank_register_history', bankAccountIds: [GHOST] }],
  ] as const) {
    const response = await put([category])
    assert.equal(response.status, 400, `${field} must refuse`)
    const body = (await response.json()) as { error: string; message: string }
    assert.equal(body.error, 'invalid category at index 0')
    assert.match(body.message, new RegExp(`${field} "${GHOST}" is not (an account|a party) in this organization`))
    assert.equal(state.transactions, 0, 'an unknown reference never opens a transaction')
    reset()
  }
})

test('a reference from the wrong table refuses', async () => {
  reset()
  state.parties.set(PARTY, { is_vendor: true, subsidiary_id: null })
  const response = await put([
    {
      id: 'category-gl',
      name: 'GL',
      direction: 'outflow',
      method: 'gl_history_average',
      accountIds: [PARTY],
    },
  ])
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 0',
    message: `accountIds "${PARTY}" is not an account in this organization`,
  })
  assert.equal(state.transactions, 0)
})

test('references that resolve persist with their ids intact', async () => {
  reset()
  state.accounts.set(ACCT, { type: 'expense', is_summary: false, subsidiary_id: null })
  state.parties.set(PARTY, { is_vendor: true, subsidiary_id: null })
  const response = await put([
    {
      id: 'category-gl',
      name: 'GL',
      direction: 'outflow',
      method: 'gl_history_average',
      accountIds: [ACCT],
    },
    {
      id: 'category-vp',
      name: 'VP',
      direction: 'outflow',
      method: 'vendor_payment_history',
      partyIds: [PARTY],
    },
  ])
  assert.equal(response.status, 200)
  const body = (await response.json()) as { ok: boolean; categories: Array<{ accountIds?: string[]; partyIds?: string[] }>; revision: number }
  assert.equal(body.revision, 8)
  assert.deepEqual(body.categories[0]?.accountIds, [ACCT])
  assert.deepEqual(body.categories[1]?.partyIds, [PARTY])
})

const SUB_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const SUB_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

test('a mistyped account refuses naming the expected type', async () => {
  reset()
  state.accounts.set(ACCT, { type: 'expense', is_summary: false, subsidiary_id: null })
  for (const [field, category, expected] of [
    ['bankAccountIds', { id: 'c1', name: 'BR', direction: 'outflow', method: 'bank_register_history', bankAccountIds: [ACCT] }, 'must be a bank account (asset_bank), got "expense"'],
    ['cardAccountIds', { id: 'c2', name: 'CC', direction: 'outflow', method: 'credit_card_cycle', cardAccountIds: [ACCT] }, 'must be a card account (liability_card), got "expense"'],
  ] as const) {
    const response = await put([category])
    assert.equal(response.status, 400, `${field} must refuse`)
    assert.deepEqual(await response.json(), {
      error: 'invalid category at index 0',
      message: `${field} "${ACCT}" ${expected}`,
    })
    assert.equal(state.transactions, 0, 'a mistyped account never opens a transaction')
    reset()
    state.accounts.set(ACCT, { type: 'expense', is_summary: false, subsidiary_id: null })
  }
})

test('a summary account refuses as a GL history source', async () => {
  reset()
  state.accounts.set(ACCT, { type: 'expense', is_summary: true, subsidiary_id: null })
  const response = await put([
    { id: 'c1', name: 'GL', direction: 'outflow', method: 'gl_history_average', accountIds: [ACCT] },
  ])
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 0',
    message: `accountIds "${ACCT}" must be a postable account, not a summary account`,
  })
  assert.equal(state.transactions, 0)
})

test('a party with no vendor role refuses for vendor methods', async () => {
  reset()
  state.parties.set(PARTY, { is_vendor: false, subsidiary_id: null })
  const response = await put([
    { id: 'c1', name: 'VP', direction: 'outflow', method: 'vendor_payment_history', partyIds: [PARTY] },
  ])
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 0',
    message: `partyIds "${PARTY}" is not a vendor in this organization`,
  })
  assert.equal(state.transactions, 0)
})

test('a customer-kind party holding a vendor role saves', async () => {
  reset()
  state.parties.set(PARTY, { is_vendor: true, subsidiary_id: null })
  const response = await put([
    { id: 'c1', name: 'VP', direction: 'outflow', method: 'vendor_payment_history', partyIds: [PARTY] },
  ])
  assert.equal(response.status, 200)
  const body = (await response.json()) as { ok: boolean; revision: number }
  assert.equal(body.revision, 8)
})

test('a reference outside the caller subsidiaries refuses', async () => {
  reset()
  state.accounts.set(ACCT, { type: 'expense', is_summary: false, subsidiary_id: SUB_A })
  state.allowedSubs = new Set([SUB_B])
  const response = await put([
    { id: 'c1', name: 'GL', direction: 'outflow', method: 'gl_history_average', accountIds: [ACCT] },
  ])
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid category at index 0',
    message: `accountIds "${ACCT}" is outside your subsidiaries`,
  })
  assert.equal(state.transactions, 0)
})

test('references in visible subsidiaries and org-wide rows persist', async () => {
  reset()
  state.accounts.set(ACCT, { type: 'expense', is_summary: false, subsidiary_id: SUB_A })
  state.accounts.set(GHOST, { type: 'expense', is_summary: false, subsidiary_id: null })
  state.allowedSubs = new Set([SUB_A])
  const response = await put([
    { id: 'c1', name: 'GL', direction: 'outflow', method: 'gl_history_average', accountIds: [ACCT, GHOST] },
  ])
  assert.equal(response.status, 200)
  const body = (await response.json()) as { ok: boolean; revision: number }
  assert.equal(body.revision, 8)
})

test('an unknown direction refuses instead of flipping the sign', async () => {
  for (const direction of ['outflwo', 'INCOME', '', null, undefined]) {
    reset()
    const candidate = { ...validCategory, id: 'category-direction' }
    if (direction === undefined) delete (candidate as Record<string, unknown>).direction
    else (candidate as Record<string, unknown>).direction = direction
    const response = await put([candidate])
    assert.equal(response.status, 400, `direction ${String(direction)} must refuse`)
    assert.deepEqual(await response.json(), {
      error: 'invalid category at index 0',
      message: 'Each category must include a valid name, method, and method-specific configuration.',
    })
    assert.equal(state.transactions, 0, 'a misspelled direction never opens a transaction')
  }
})

test('manual schedules keep an explicit anchor and refuse a malformed one', async () => {
  reset()

  const anchored = {
    id: 'category-anchored',
    name: 'Anchored rent',
    direction: 'outflow',
    method: 'manual_recurring',
    amount: '1000.0000',
    frequency: 'monthly',
    anchorDate: '2026-08-30',
  }
  const kept = await put([anchored])
  assert.equal(kept.status, 200)
  assert.deepEqual(await kept.json(), { ok: true, categories: [anchored], revision: 8 })

  for (const bad of ['2026-02-30', '2026-13-01', 'not-a-date', 20260830]) {
    reset()
    const response = await put([{ ...anchored, id: 'category-bad', anchorDate: bad }])
    assert.equal(response.status, 400, `anchorDate ${String(bad)} must refuse`)
    assert.deepEqual(await response.json(), {
      error: 'invalid category at index 0',
      message: 'Each category must include a valid name, method, and method-specific configuration.',
    })
    assert.equal(state.transactions, 0, 'a malformed anchor never opens a transaction')
  }
})
