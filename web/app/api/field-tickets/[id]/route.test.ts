import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite: the real field-ticket service runs against a scripted
// database fake, pinning the exact-revision fence end to end.
const stateKey = Symbol.for('openbooks.fieldticket-route-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface RouteState {
  calls: DbCall[]
  respondExecute: (text: string) => { rows: unknown[] }
  respondTxExecute: (text: string) => { rows: unknown[] }
}
const routeState: RouteState = {
  calls: [],
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextTicket?: unknown }).openbooksSqlTextTicket = sqlText

const TICKET_ID = '00000000-0000-4000-8000-00000000f001'
const PROJECT_ID = '00000000-0000-4000-8000-00000000f002'
const EMPLOYEE_ID = '00000000-0000-4000-8000-00000000f003'
const TIME_TYPE_ID = '00000000-0000-4000-8000-00000000f004'
const STORED_REVISION = '2026-08-24T12:00:00.300001Z'

function headerRow(revision: string) {
  return {
    id: TICKET_ID,
    document_number: 'FT-1',
    status: 'draft',
    party_id: null,
    project_id: PROJECT_ID,
    currency: 'CAD',
    document_date: '2026-08-24',
    reference_number: null,
    memo: null,
    revision,
    period: 'daily',
    period_start: '2026-08-24',
    period_end: '2026-08-24',
    foreman_party_id: null,
    charge_document_id: null,
    submitted_by: null,
    submitted_at: null,
    rejection_reason: null,
  }
}

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.fieldticket-route-test')]
      const sqlText = globalThis.openbooksSqlTextTicket
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
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission === 'time.read' || permission === 'time.manage') {
          return { user: { orgId: 'org-1', id: 'user-1' } }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  [
    'mock:signing',
    `export async function sendTicketForSignature() {
       throw new Error('unexpected signature dispatch')
     }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/features', 'mock:features'],
  ['../../../../lib/field-ticket-signing', 'mock:signing'],
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

const routeUrl = './route.ts?fieldticket-occ-test'
const { PATCH, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const NEXT_REVISION = '2026-08-24T12:00:00.300002Z'

function reset(): void {
  routeState.calls.length = 0
  routeState.respondExecute = () => ({ rows: [] })
  routeState.respondTxExecute = () => ({ rows: [] })
}

/** Serve the read-only queries the ticket service makes outside the fence. */
function serveReads(currentRevision: () => string): void {
  routeState.respondExecute = (text) => {
    if (text.includes('ft.period_start')) return { rows: [headerRow(currentRevision())] }
    if (text.includes('count(*)::int')) return { rows: [{ n: 0 }] }
    if (text.includes('show_on_field_ticket')) return { rows: [{ id: TIME_TYPE_ID }] }
    return { rows: [] }
  }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/field-tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TICKET_ID }) },
  )
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/field-tickets/${TICKET_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TICKET_ID }) },
  )
}

test('PATCH rejects a missing revision token before any write', async () => {
  reset()

  const response = await patch({ memo: 'no token' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the document revision is required; reload and review the latest revision',
  })
  assert.ok(!routeState.calls.some((call) => call.kind === 'tx-execute'), 'no transactional write ran')
})

test('PATCH rejects a stale revision with a conflict and no partial write', async () => {
  reset()
  serveReads(() => STORED_REVISION)
  routeState.respondTxExecute = (text) =>
    text.includes('for update') ? { rows: [{ status: 'draft', updatedAt: NEXT_REVISION }] } : { rows: [] }

  const response = await patch({ memo: 'stale save', expectedRevision: STORED_REVISION })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this document changed after you opened it; reload and review the latest revision',
  })
  assert.ok(!routeState.calls.some((call) => call.text.includes('update documents')), 'no header overwrite ran')
})

test('PATCH saves the header under an exact matching revision and returns the fresh token', async () => {
  reset()
  let currentRevision = STORED_REVISION
  serveReads(() => currentRevision)
  routeState.respondTxExecute = (text) => {
    if (text.includes('for update')) {
      return { rows: [{ status: 'draft', updatedAt: currentRevision }] }
    }
    if (text.includes('update documents')) {
      assert.match(text, /greatest\(/, 'the token advances monotonically inside the lock')
      currentRevision = NEXT_REVISION
    }
    return { rows: [] }
  }

  const response = await patch({ memo: 'concurrent-safe save', expectedRevision: STORED_REVISION })

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { revision: string }
  assert.equal(payload.revision, NEXT_REVISION, 'the caller can chain the next exact save')
  const lock = routeState.calls.find((call) => call.kind === 'tx-execute' && call.text.includes('for update'))
  assert.ok(lock, 'the write transaction locks the ticket row first')
})

test('POST save-grid fences the grid replacement behind the same revision token', async () => {
  reset()
  let currentRevision = STORED_REVISION
  serveReads(() => currentRevision)
  routeState.respondTxExecute = (text) => {
    if (text.includes('for update')) {
      return { rows: [{ status: 'draft', updatedAt: currentRevision }] }
    }
    if (text.includes('insert into time_entries')) currentRevision = NEXT_REVISION
    return { rows: [] }
  }

  // Missing token → refused before anything is written.
  const refused = await post({
    action: 'save-grid',
    rows: [{ employeePartyId: EMPLOYEE_ID, itemId: null, timeTypeId: TIME_TYPE_ID, hours: { '2026-08-24': '8' } }],
  })
  assert.equal(refused.status, 409)

  // Stale token → conflict, no grid write.
  routeState.calls.length = 0
  const stale = await post({
    action: 'save-grid',
    expectedRevision: '2000-01-01T00:00:00.000000Z',
    rows: [{ employeePartyId: EMPLOYEE_ID, itemId: null, timeTypeId: TIME_TYPE_ID, hours: { '2026-08-24': '8' } }],
  })
  assert.equal(stale.status, 409)
  assert.ok(!routeState.calls.some((call) => call.text.includes('insert into time_entries')))

  // Exact token → the grid lands atomically inside the fenced transaction.
  const saved = await post({
    action: 'save-grid',
    expectedRevision: STORED_REVISION,
    rows: [{ employeePartyId: EMPLOYEE_ID, itemId: null, timeTypeId: TIME_TYPE_ID, hours: { '2026-08-24': '8' } }],
  })
  assert.equal(saved.status, 200)
  const payload = (await saved.json()) as { revision: string }
  assert.equal(payload.revision, NEXT_REVISION)
  const inserted = routeState.calls.find((call) => call.kind === 'tx-execute' && call.text.includes('insert into time_entries'))
  assert.ok(inserted, 'the crew cell was written inside the fence')
})
