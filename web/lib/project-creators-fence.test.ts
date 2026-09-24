import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Project-domain creator fence: createProjectCharge and createBillingRequest
// gate Projects at the entry, then must recheck the gate INSIDE the write
// transaction. A disable committing between the entry check and the insert
// must refuse the write instead of committing a hidden charge or request.

const stateKey = Symbol.for('openbooks.project-creators-fence-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface FenceState {
  calls: DbCall[]
  /** Features visible to pre-transaction entry checks. */
  entryFeatures: Record<string, boolean>
  /** Features visible to the in-transaction fenced recheck. */
  txFeatures: Record<string, boolean>
}
const fenceState: FenceState = {
  calls: [],
  entryFeatures: { projects: true, equipment: true, inventory: true },
  txFeatures: { projects: true },
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextCreators?: unknown }).openbooksSqlTextCreators = sqlText

const PROJECT_ID = '00000000-0000-4000-8000-00000000c101'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.project-creators-fence-test')]
      const sqlText = globalThis.openbooksSqlTextCreators
      const respond = (kind, text) => {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] }
        // The fenced recheck reads the flag the disable may just have written.
        if (text.includes('for share') && text.includes('from orgs')) return { rows: [{ features: state.txFeatures }] }
        if (text.includes("as f from orgs")) return { rows: [{ f: state.entryFeatures }] }
        if (text.includes('as time_zone from orgs')) return { rows: [] }
        // Billing-request entry preflight: the project lookup, the type
        // default (no configured type, so the built-in T&M answers), and the
        // invoicing-preference cascade. Keyword order is specific-first:
        // drizzle preserves the template newlines, so a bare from-projects
        // check never matches with a single-space suffix.
        if (text.includes('customer_po_number')) return { rows: [{ id: '${PROJECT_ID}', customer_po_number: null }] }
        if (text.includes('project_financial_profile_versions')) return { rows: [] }
        if (text.includes('invoicing_preference as project_pref')) return { rows: [{}] }
        if (text.includes('from projects')) return { rows: [{ id: '${PROJECT_ID}', subsidiary_id: null }] }
        throw new Error('unexpected query: ' + text)
      }
      const txRunner = () => ({ execute: (query) => {
        const text = sqlText(query)
        state.calls.push({ kind: 'tx-execute', text })
        return Promise.resolve(respond('tx-execute', text))
      } })
      export const db = {
        execute: (query) => {
          const text = sqlText(query)
          state.calls.push({ kind: 'execute', text })
          return Promise.resolve(respond('execute', text))
        },
        transaction: async (work) => work(txRunner()),
      }
      export async function inDbTransaction(work) { return work(txRunner()) }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
      // postDocument (m58 PA1) opens a maintenance transaction for an ambient
      // bypass with no pinned transaction. This suite never establishes an
      // ambient context (orgContext.getStore() is always null above), so the
      // real reader also answers false on every reachable state here.
      export function ambientBypassWithoutTransaction() { return false }
      export const pool = {}
      export const env = {}
      // Link-time surface for the wider engine chain: these paths never run them.
      export const orgContext = { getStore: () => null, run: (_store, fn) => fn() }
      export const longPool = {}
      export async function connectGovernedReadClient() { throw new Error('unexpected connectGovernedReadClient') }
      export async function assertSafeRuntimeDatabaseRole() {}
      export const runtimeDatabaseRoleCheckRequired = false
      export async function withMaintenanceTransaction(...args) { return args[args.length - 1]() }
      export async function withTransactionSavepoint(_runner, fn) { return fn() }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Next's webpack alias (`@/*` → `web/*`): this suite lives in web/lib/,
    // so `@/lib/x` is the sibling `./x`.
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`./${specifier.slice('@/lib/'.length)}.ts`, context.parentURL).href, context)
    }
    // Engine modules import the pool through relative paths (`./db.ts` inside
    // platform/, `../platform/db.ts` elsewhere), not the workspace
    // specifier: normalize every load of the platform pool to the double, or
    // engine helpers (business clocks, type defaults) would run their reads
    // on a real connection.
    if (
      specifier === '@openbooks/engine/src/platform/db.ts' ||
      specifier.endsWith('/platform/db.ts') ||
      (specifier === './db.ts' && context.parentURL?.includes('/engine/src/platform/'))
    ) {
      return { url: 'mock:db', shortCircuit: true }
    }
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

// Query-suffixed URLs keep these module instances apart from any other
// suite's copy; indirected through a const so tsc does not try to resolve
// the suffixed path as a type-level module.
const chargesUrl = './project-charges.ts?creators-fence-test'
const requestsUrl = './billing-requests.ts?creators-fence-test'
const chargesModule = (await import(chargesUrl)) as unknown as {
  createProjectCharge: (
    orgId: string,
    userId: string,
    input: { projectId: string; lines: unknown[] },
    opts: { post: boolean; allowedSubsidiaryIds: Set<string> | null },
  ) => Promise<unknown>
  ChargeError: new (message?: string) => Error
}
const requestsModule = (await import(requestsUrl)) as unknown as {
  createBillingRequest: (orgId: string, userId: string, input: { projectId: string }) => Promise<unknown>
}
hooks.deregister()

function reset(): void {
  fenceState.calls.length = 0
  fenceState.entryFeatures = { projects: true, equipment: true, inventory: true }
  fenceState.txFeatures = { projects: true }
}

function txTexts(): string[] {
  return fenceState.calls.filter((c) => c.kind === 'tx-execute').map((c) => c.text)
}

test('createProjectCharge refuses a Projects disable committed before the insert', async () => {
  reset()
  fenceState.txFeatures = { projects: false }
  await assert.rejects(
    chargesModule.createProjectCharge('org-1', 'user-1', {
      projectId: PROJECT_ID,
      lines: [{ itemId: '00000000-0000-4000-8000-00000000c102', quantity: '1', costRate: '10', billRate: '20' }],
    }, { post: true, allowedSubsidiaryIds: null }),
    (error: unknown) => error instanceof chargesModule.ChargeError && error.message === 'Projects feature is disabled',
  )
  const texts = txTexts()
  // Fence and recheck are the first statements; the charge never inserts.
  assert.ok(texts.length >= 2)
  assert.ok(texts[0]!.includes('pg_advisory_xact_lock'), 'fence first')
  assert.ok(texts[1]!.includes('for share') && texts[1]!.includes('from orgs'), 'fenced recheck second')
  assert.ok(!texts.some((t) => t.includes('insert into documents')), 'a refused charge must never reach the table')
})

test('createBillingRequest refuses a Projects disable committed before the insert', async () => {
  reset()
  fenceState.txFeatures = { projects: false }
  await assert.rejects(
    requestsModule.createBillingRequest('org-1', 'user-1', { projectId: PROJECT_ID }),
    (error: unknown) => error instanceof Error && error.message === 'Projects feature is disabled',
  )
  const texts = txTexts()
  // Numbering lock, feature-gate fence, fenced recheck — then the refusal.
  assert.ok(texts.length >= 3)
  assert.ok(texts[0]!.includes('pg_advisory_xact_lock'), 'numbering lock first')
  assert.ok(texts[1]!.includes('pg_advisory_xact_lock'), 'feature-gate fence second')
  assert.ok(texts[2]!.includes('for share') && texts[2]!.includes('from orgs'), 'fenced recheck third')
  assert.ok(!texts.some((t) => t.includes('insert into billing_requests')), 'a refused request must never reach the table')
})
