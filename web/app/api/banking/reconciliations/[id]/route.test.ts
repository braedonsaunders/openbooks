import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface ReconciliationValues {
  throughDate: string
  statementBalance: string
}

interface AuditSnapshot {
  before: ReconciliationValues
  after: ReconciliationValues
}

interface RouteState {
  committed: ReconciliationValues
  desired: ReconciliationValues[]
  audits: AuditSnapshot[]
  nextTransactionId: number
  lockTail: Promise<void>
}

const stateKey = Symbol.for('openbooks.reconciliation-route-test')
const routeState: RouteState = {
  committed: {
    throughDate: '2026-08-20',
    statementBalance: '100.00',
  },
  desired: [],
  audits: [],
  nextTransactionId: 0,
  lockTail: Promise.resolve(),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into text for routing the database fake. */
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
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const mockSources = new Map<string, string>([
  [
    'mock:next-server',
    `
      export class NextResponse extends Response {
        static json(value, init = {}) {
          const headers = new Headers(init.headers)
          headers.set('content-type', 'application/json')
          return new NextResponse(JSON.stringify(value), { ...init, headers })
        }
      }
    `,
  ],
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        const queryChunks = []
        for (let i = 0; i < strings.length; i += 1) {
          queryChunks.push(strings[i])
          if (i < values.length) queryChunks.push(values[i])
        }
        return { queryChunks }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.reconciliation-route-test')]
      const sqlText = globalThis.openbooksReconciliationSqlText

      export const db = {
        transaction: async (work) => {
          const transactionId = state.nextTransactionId++
          let releaseLock
          const transaction = {
            execute: async (query) => {
              const text = sqlText(query)
              if (text.includes('select id, org_id, through_date, statement_balance')) {
                if (text.includes('for update')) {
                  const waitForPrevious = state.lockTail
                  let resolveLock
                  state.lockTail = new Promise((resolve) => { resolveLock = resolve })
                  await waitForPrevious
                  releaseLock = resolveLock
                }
                const before = { ...state.committed }
                transaction.before = before
                return {
                  rows: [{
                    id: '00000000-0000-4000-8000-000000000001',
                    org_id: 'org-1',
                    through_date: before.throughDate,
                    statement_balance: before.statementBalance,
                  }],
                }
              }
              if (text.includes('update reconciliations')) {
                const after = state.desired[transactionId]
                if (!after) throw new Error('missing desired reconciliation values')
                state.committed = { ...after }
                return {
                  rows: [{
                    through_date: after.throughDate,
                    statement_balance: after.statementBalance,
                  }],
                }
              }
              if (text.includes('insert into audit_log')) {
                state.audits.push({ before: transaction.before, after: { ...state.committed } })
              }
              return { rows: [] }
            },
          }
          try {
            return await work(transaction)
          } finally {
            if (releaseLock) releaseLock()
          }
        },
      }
    `,
  ],
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
    'mock:banking',
    `
      export class BankingError extends Error {
        constructor(message, status = 422) {
          super(message)
          this.status = status
        }
      }
      export async function reconciliationTotals() {
        return { matched: 0, unmatched: 0 }
      }
      export async function discardReconciliation() {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid() { return true }
    `,
  ],
  [
    'mock:util',
    `
      export function bankingErrorResponse(error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'error' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        })
      }
    `,
  ],
  [
    'mock:money',
    `
      export function normalizeMoney(value) { return value }
    `,
  ],
  [
    'mock:exact-decimal',
    `
      export function canonicalDecimal(value) {
        return typeof value === 'string' ? value : null
      }
    `,
  ],
])

;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksReconciliationSqlText?: unknown })
  .openbooksReconciliationSqlText = sqlText

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['next/server', 'mock:next-server'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/banking.ts', 'mock:banking'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../util', 'mock:util'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
  ['../../../../../lib/exact-decimal', 'mock:exact-decimal'],
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

const routeUrl = './route.ts?reconciliation-concurrency-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const RECONCILIATION_ID = '00000000-0000-4000-8000-000000000001'

function reset(): void {
  routeState.committed = {
    throughDate: '2026-08-20',
    statementBalance: '100.00',
  }
  routeState.desired = [
    { throughDate: '2026-08-21', statementBalance: '110.00' },
    { throughDate: '2026-08-22', statementBalance: '120.00' },
  ]
  routeState.audits.length = 0
  routeState.nextTransactionId = 0
  routeState.lockTail = Promise.resolve()
}

function patch(body: Record<string, string>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/banking/reconciliations/${RECONCILIATION_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RECONCILIATION_ID }) },
  )
}

test('concurrent PATCH requests chain audit snapshots from committed reconciliation values', async () => {
  reset()

  const responses = await Promise.all([
    patch({ throughDate: '2026-08-21', statementBalance: '110.00' }),
    patch({ throughDate: '2026-08-22', statementBalance: '120.00' }),
  ])

  assert.deepEqual(responses.map((response) => response.status), [200, 200])
  assert.deepEqual(routeState.audits, [
    {
      before: { throughDate: '2026-08-20', statementBalance: '100.00' },
      after: { throughDate: '2026-08-21', statementBalance: '110.00' },
    },
    {
      before: { throughDate: '2026-08-21', statementBalance: '110.00' },
      after: { throughDate: '2026-08-22', statementBalance: '120.00' },
    },
  ])
})
