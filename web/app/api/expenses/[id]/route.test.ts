import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite: the real documents OCC primitives run against a
// scripted database fake, pinning the exact-revision fence end to end.
const stateKey = Symbol.for('openbooks.expense-route-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface AuditCall { action: string; documentId: string }
interface RouteState {
  calls: DbCall[]
  auditCalls: AuditCall[]
  report: { doc: Record<string, unknown>; lines: unknown[] } | null
  respondExecute: (text: string) => { rows: unknown[] }
  respondTxExecute: (text: string) => { rows: unknown[] }
}
const routeState: RouteState = {
  calls: [],
  auditCalls: [],
  report: null,
  respondExecute: () => ({ rows: [] }),
  respondTxExecute: () => ({ rows: [] }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into its raw text for keyword assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlText?: unknown }).openbooksSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      const sqlText = globalThis.openbooksSqlText
      const record = (kind, query) => {
        state.calls.push({ kind, text: sqlText(query) })
        const respond = kind === 'tx-execute' ? state.respondTxExecute : state.respondExecute
        return Promise.resolve(respond(sqlText(query)))
      }
      export const db = {
        execute: (query) => record('execute', query),
        transaction: async (work) => {
          const tx = { execute: (query) => record('tx-execute', query) }
          return work(tx)
        },
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function inDbTransaction(_work) { throw new Error('unexpected inDbTransaction') }
      export function registerRequestOrgResolver() {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission(permission) {
        if (permission === 'expenses.read' || permission === 'expenses.create') {
          return {
            user: { orgId: 'org-1', id: 'user-1' },
            allowedSubsidiaryIds: null,
          }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
  [
    'mock:transaction-audit',
    `
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      export async function captureTransactionAuditSnapshot() {
        return { snapshot: true }
      }
      export async function recordTransactionAudit(_tx, input) {
        state.auditCalls.push({ action: input.action, documentId: input.documentId })
      }
    `,
  ],
  [
    'mock:expenses-loader',
    `
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      export async function loadExpenseReport(id, orgId) {
        return state.report
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/transaction-audit.ts', 'mock:transaction-audit'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../lib/expenses', 'mock:expenses-loader'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as documents.test.ts).
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
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

const routeUrl = './route.ts?expense-occ-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const STORED_REVISION = '2026-08-24T12:00:00.100001Z'
const NEXT_REVISION = '2026-08-24T12:00:00.100002Z'
const EXPENSE_ID = '00000000-0000-4000-8000-00000000e001'

function reset(): void {
  routeState.calls.length = 0
  routeState.auditCalls.length = 0
  routeState.respondExecute = (text) =>
    // The org-wide subsidiary scope probe every handler runs before loading.
    text.includes('subsidiaryId') ? { rows: [{ subsidiaryId: null }] } : { rows: [] }
  routeState.respondTxExecute = () => ({ rows: [] })
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/expenses/${EXPENSE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: EXPENSE_ID }) },
  )
}

function get(): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/expenses/${EXPENSE_ID}`),
    { params: Promise.resolve({ id: EXPENSE_ID }) },
  )
}

test('PATCH rejects a missing revision token before any write', async () => {
  reset()
  routeState.respondExecute = (text) =>
    text.includes('status') && text.includes('document_date')
      ? { rows: [{ status: 'draft', document_date: '2026-08-24', subsidiaryId: null }] }
      : { rows: [] }

  const response = await patch({ memo: 'no token' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the document revision is required; reload and review the latest revision',
  })
  assert.ok(!routeState.calls.some((call) => call.kind === 'tx-execute'), 'no transactional write ran')
})

test('PATCH rejects a stale revision with a conflict and no partial write', async () => {
  reset()
  routeState.respondExecute = (text) =>
    text.includes('from documents') && text.includes('status')
      ? { rows: [{ status: 'draft', document_date: '2026-08-24', subsidiaryId: null }] }
      : { rows: [] }
  routeState.respondTxExecute = (text) =>
    text.includes('for update') ? { rows: [{ status: 'draft', updatedAt: NEXT_REVISION }] } : { rows: [] }

  const response = await patch({ memo: 'stale save', expectedUpdatedAt: STORED_REVISION })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this document changed after you opened it; reload and review the latest revision',
  })
  assert.equal(routeState.auditCalls.length, 0, 'the fenced write never reached the audit trail')
  assert.ok(!routeState.calls.some((call) => call.text.includes('update documents')), 'no header overwrite ran')
})

test('a non-draft expense report still refuses edits outright', async () => {
  reset()
  routeState.respondExecute = (text) =>
    text.includes('status') ? { rows: [{ status: 'posted', document_date: '2026-08-24', subsidiaryId: null }] } : { rows: [] }

  const response = await patch({ memo: 'x', expectedUpdatedAt: STORED_REVISION })

  assert.equal(response.status, 422)
  assert.match(((await response.json()) as { error: string }).error, /posted expense report cannot be edited/)
})

test('PATCH saves only under an exact matching revision and returns the fresh token', async () => {
  reset()
  let storedRevision = STORED_REVISION
  routeState.report = { doc: { id: EXPENSE_ID, subtotal: '10.00' }, lines: [] }
  routeState.respondExecute = (text) => {
    if (text.includes('status') && text.includes('document_date')) {
      return { rows: [{ status: 'draft', document_date: '2026-08-24', subsidiaryId: null }] }
    }
    // The exact-token projection that adorns the response payload.
    if (text.includes('updatedAt')) return { rows: [{ updatedAt: storedRevision }] }
    return { rows: [] }
  }
  routeState.respondTxExecute = (text) => {
    if (text.includes('for update')) {
      return { rows: [{ status: 'draft', updatedAt: storedRevision }] }
    }
    if (text.includes('update documents')) {
      assert.match(text, /greatest\(/, 'the token advances monotonically inside the lock')
      storedRevision = NEXT_REVISION
      return { rows: [] }
    }
    return { rows: [] }
  }

  const response = await patch({ memo: 'concurrent-safe save', expectedUpdatedAt: STORED_REVISION })

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { doc: { updated_at: string } }
  assert.equal(payload.doc.updated_at, NEXT_REVISION, 'the caller can chain the next exact save')
  assert.deepEqual(routeState.auditCalls, [{ action: 'update', documentId: EXPENSE_ID }])
  const lock = routeState.calls.find((call) => call.kind === 'tx-execute' && call.text.includes('for update'))
  assert.ok(lock, 'the write transaction locks the row first')
})

test('GET exposes the exact persisted revision so callers can fence their next save', async () => {
  reset()
  routeState.report = { doc: { id: EXPENSE_ID }, lines: [] }
  routeState.respondExecute = (text) => {
    // The org-wide subsidiary scope probe runs before the payload loads.
    if (text.includes('subsidiaryId')) return { rows: [{ subsidiaryId: null }] }
    if (text.includes('updatedAt')) return { rows: [{ updatedAt: STORED_REVISION }] }
    return { rows: [] }
  }

  const response = await get()

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { doc: { updated_at: string } }
  assert.equal(payload.doc.updated_at, STORED_REVISION)
})
