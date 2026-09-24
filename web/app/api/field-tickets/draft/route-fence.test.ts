import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Instant-draft fence: the draft POST gates Field Tickets at the entry, then
// createFieldTicket must recheck the gate INSIDE the creation transaction. A
// disable committing between the entry check and the insert must refuse the
// draft instead of committing a ticket hidden behind a disabled gate.

const stateKey = Symbol.for('openbooks.fieldticket-draft-fence-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface FenceState {
  calls: DbCall[]
  /** Features visible to the pre-transaction entry guard. */
  entryFeatures: Record<string, boolean>
  /** Features visible to the in-transaction fenced recheck. */
  txFeatures: Record<string, boolean>
}
const fenceState: FenceState = {
  calls: [],
  entryFeatures: { fieldTickets: true },
  txFeatures: { fieldTickets: true },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = fenceState

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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextDraftFence?: unknown }).openbooksSqlTextDraftFence = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.fieldticket-draft-fence-test')]
      const sqlText = globalThis.openbooksSqlTextDraftFence
      const respond = (text) => {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] }
        // The fenced recheck reads the flag the disable may just have written.
        if (text.includes('for share') && text.includes('from orgs')) return { rows: [{ features: state.txFeatures }] }
        if (text.includes("as f from orgs")) return { rows: [{ f: state.entryFeatures }] }
        // The org exists with no stored zone: the business clock days in UTC.
        if (text.includes("as time_zone from orgs")) return { rows: [{ time_zone: null }] }
        if (text.includes('from field_ticket_policies')) return { rows: [] }
        if (text.includes('select base_currency from orgs')) return { rows: [{ base_currency: 'CAD' }] }
        if (text.includes('from users where')) return { rows: [{ party_id: null }] }
        // First allocation floors past already-issued numbers; none exist yet.
        if (text.includes(' as mx') && text.includes('from documents')) return { rows: [{ mx: 0 }] }
        if (text.includes('insert into number_sequences')) return { rows: [{ prefix: 'FT-', next_number: 1, padding: 5 }] }
        if (text.includes('insert into documents')) return { rows: [{ id: 'doc-1', document_number: 'FT-00001' }] }
        if (text.includes('insert into field_tickets')) return { rows: [] }
        throw new Error('unexpected query: ' + text)
      }
      const record = (kind, query) => {
        const text = sqlText(query)
        state.calls.push({ kind, text })
        return Promise.resolve(respond(text))
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
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
      export const ambientBypassWithoutTransaction = () => false
      export const pool = {}
      export const env = {}
      // Link-time surface for the wider engine chain (flows, savepoints):
      // these paths never run them.
      export const orgContext = { getStore: () => null, run: (_store, fn) => fn() }
      export const longPool = {}
      export async function connectGovernedReadClient() { throw new Error('unexpected connectGovernedReadClient') }
      export async function assertSafeRuntimeDatabaseRole() {}
      export const runtimeDatabaseRoleCheckRequired = false
      export async function withMaintenanceTransaction(...args) { return args[args.length - 1]() }
      export async function withTransactionSavepoint(_runner, fn) { return fn() }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission === 'time.manage') {
          return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
        }
        return new Response(null, { status: 403 })
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    // Engine modules import the pool through relative paths (`./db.ts` inside
    // platform/, `../platform/db.ts` elsewhere), not the workspace
    // specifier: normalize every load of the platform pool to the double, or
    // engine helpers (business clocks) would run their reads on a real
    // connection.
    if (
      specifier === '@openbooks/engine/src/platform/db.ts' ||
      specifier.endsWith('/platform/db.ts') ||
      (specifier === './db.ts' && context.parentURL?.includes('/engine/src/platform/'))
    ) {
      return { url: 'mock:db', shortCircuit: true }
    }
    // The ticket service gates itself on the same feature module via a
    // sibling-relative specifier; route it to the real module (only db and
    // authz are doubled here, so the real gate logic runs).
    if (specifier === './features' && context.parentURL?.endsWith('/lib/field-tickets.ts')) {
      return nextResolve(new URL('./features.ts', context.parentURL).href, context)
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

const routeUrl = './route.ts?fieldticket-draft-fence-test'
const routeModule = (await import(routeUrl)) as { POST: () => Promise<Response> }
const { POST } = routeModule
hooks.deregister()

function reset(): void {
  fenceState.calls.length = 0
  fenceState.entryFeatures = { fieldTickets: true }
  fenceState.txFeatures = { fieldTickets: true }
}

function texts(): string[] {
  return fenceState.calls.map((c) => c.text)
}

test('instant draft rechecks Field Tickets inside the creation transaction', async () => {
  reset()
  const res = await POST()
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json().catch(() => null)))
  const body = (await res.json()) as { id: string; documentNumber: string }
  assert.equal(body.id, 'doc-1')
  assert.equal(body.documentNumber, 'FT-00001')
  const all = texts()
  const fence = all.findIndex((t) => t.includes('pg_advisory_xact_lock'))
  const recheck = all.findIndex((t) => t.includes('for share') && t.includes('from orgs'))
  const insert = all.findIndex((t) => t.includes('insert into documents'))
  assert.ok(fence >= 0, 'creation takes the feature-gate fence')
  assert.ok(recheck >= 0, 'creation rechecks the gate under a shared row lock')
  assert.ok(insert >= 0, 'the draft ticket inserts')
  assert.ok(fence < recheck && recheck < insert, 'fence, recheck, then insert — in that order')
})

test('instant draft refused when Field Tickets disables before the insert', async () => {
  reset()
  // The entry guard still sees the old enabled flag; the disable commits
  // before the creation transaction rechecks.
  fenceState.entryFeatures = { fieldTickets: true }
  fenceState.txFeatures = { fieldTickets: false }
  const res = await POST()
  assert.equal(res.status, 404)
  assert.ok(
    !texts().some((t) => t.includes('insert into documents')),
    'a refused draft must never reach the table',
  )
})
