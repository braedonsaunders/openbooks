import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Construction write fence: addSov/addChangeOrder gate Projects at the route
// entry, then must recheck the gate INSIDE the write transaction. A disable
// committing between the entry check and the insert must refuse the write
// instead of committing a hidden SOV line or change order.

const stateKey = Symbol.for('openbooks.construction-fence-test')
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
  entryFeatures: { projects: true },
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextConstruction?: unknown }).openbooksSqlTextConstruction = sqlText

const PROJECT_ID = '00000000-0000-4000-8000-00000000c001'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.construction-fence-test')]
      const sqlText = globalThis.openbooksSqlTextConstruction
      const respond = (kind, text) => {
        if (kind === 'tx-execute') {
          if (text.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] }
          // The fenced recheck reads the flag the disable may just have written.
          if (text.includes('for share') && text.includes('from orgs')) return { rows: [{ features: state.txFeatures }] }
          if (text.includes('from pay_applications')) return { rows: [] }
          if (text.includes('from change_orders')) return { rows: [] }
          if (text.includes('insert into sov_lines')) return { rows: [{ id: 'sov-1' }] }
          if (text.includes('insert into change_orders')) return { rows: [{ id: 'co-1' }] }
          if (text.includes('insert into audit_log')) return { rows: [] }
          throw new Error('unexpected tx query: ' + text)
        }
        if (text.includes("as f from orgs") || text.includes('as "f" from orgs')) return { rows: [{ f: state.entryFeatures }] }
        if (text.includes('from projects where')) return { rows: [{ id: '${PROJECT_ID}', subsidiary_id: null }] }
        if (text.includes('from change_orders')) return { rows: [{ id: '${PROJECT_ID}', subsidiary_id: null }] }
        if (text.includes('invoicing_profile')) return { rows: [{ procedure: 'application_for_payment' }] }
        throw new Error('unexpected query: ' + text)
      }
      const record = (kind, query) => {
        const text = sqlText(query)
        state.calls.push({ kind, text })
        return Promise.resolve(respond(kind, text))
      }
      export const db = {
        execute: (query) => record('execute', query),
        transaction: async (work) => {
          const tx = { execute: (query) => record('tx-execute', query) }
          return work(tx)
        },
      }
      // project-costing links this name at import; these paths never run it.
      export const orgContext = { getStore: () => null, run: (_store, fn) => fn() }
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
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission === 'ar.create' || permission === 'ar.read' || permission === 'ar.approve' || permission === 'ar.post') {
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
  ['../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Next's webpack alias (`@/*` → `web/*`): this suite lives three levels
    // below web/, so `web/app/api/construction/` + `../../../` is web/.
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
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

const routeUrl = './route.ts?construction-fence-test'
const { POST } = (await import(routeUrl)) as { POST: (req: Request) => Promise<Response> }
// Both fence halves are loaded for real above (only db and authz are
// doubled): compare their per-org lock identity while the server-only stub
// is still registered.
const { featureGateLockKey: webFenceKey } = (await import('../../../lib/features')) as {
  featureGateLockKey: (orgId: string) => string
}
const { featureGateLockKey: engineFenceKey } = (await import(
  '@openbooks/engine/src/organization/org-feature-lock.ts'
)) as { featureGateLockKey: (orgId: string) => string }
hooks.deregister()

function reset(): void {
  fenceState.calls.length = 0
  fenceState.entryFeatures = { projects: true }
  fenceState.txFeatures = { projects: true }
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/construction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function txTexts(): string[] {
  return fenceState.calls.filter((c) => c.kind === 'tx-execute').map((c) => c.text)
}

test('addSov rechecks Projects inside the write transaction before inserting', async () => {
  reset()
  const res = await post({ action: 'addSov', projectId: PROJECT_ID, description: 'Mobilization', scheduledValue: '1000' })
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json().catch(() => null)))
  const texts = txTexts()
  const fence = texts.findIndex((t) => t.includes('pg_advisory_xact_lock'))
  const recheck = texts.findIndex((t) => t.includes('for share') && t.includes('from orgs'))
  const insert = texts.findIndex((t) => t.includes('insert into sov_lines'))
  assert.ok(fence >= 0, 'the write transaction takes the feature-gate fence')
  assert.ok(recheck >= 0, 'the write transaction rechecks the gate under a shared row lock')
  assert.ok(insert >= 0, 'the SOV line inserts')
  assert.ok(fence < recheck && recheck < insert, 'fence, recheck, then insert — in that order')
})

test('addSov refused when Projects disables between the entry guard and the insert', async () => {
  reset()
  // The entry guard still sees the old enabled flag; the disable commits
  // before the write transaction rechecks.
  fenceState.entryFeatures = { projects: true }
  fenceState.txFeatures = { projects: false }
  const res = await post({ action: 'addSov', projectId: PROJECT_ID, description: 'Mobilization', scheduledValue: '1000' })
  assert.equal(res.status, 422)
  assert.equal(((await res.json()) as { error: string }).error, 'Projects feature is disabled')
  assert.ok(
    !txTexts().some((t) => t.includes('insert into sov_lines')),
    'a refused SOV insert must never reach the table',
  )
})

test('addChangeOrder refused when Projects disables between the entry guard and the insert', async () => {
  reset()
  fenceState.entryFeatures = { projects: true }
  fenceState.txFeatures = { projects: false }
  const res = await post({ action: 'addChangeOrder', projectId: PROJECT_ID, number: 'CO-001', amount: '250' })
  assert.equal(res.status, 422)
  assert.equal(((await res.json()) as { error: string }).error, 'Projects feature is disabled')
  assert.ok(
    !txTexts().some((t) => t.includes('insert into change_orders')),
    'a refused change order must never reach the table',
  )
})

test('approveChangeOrder takes the fence before touching the draft order', async () => {
  reset()
  // The gate stays enabled: approval proceeds past the fence to the draft
  // lookup (which finds nothing here), proving fence, recheck, then work.
  const res = await post({ action: 'approveChangeOrder', id: '00000000-0000-4000-8000-00000000c002', approvedOn: '2026-08-31' })
  assert.equal(res.status, 422)
  assert.equal(((await res.json()) as { error: string }).error, 'Change order not found or no longer draft')
  const texts = txTexts()
  const fence = texts.findIndex((t) => t.includes('pg_advisory_xact_lock'))
  const recheck = texts.findIndex((t) => t.includes('for share') && t.includes('from orgs'))
  const lookup = texts.findIndex((t) => t.includes('from change_orders'))
  assert.ok(fence >= 0, 'the approval transaction takes the feature-gate fence')
  assert.ok(recheck >= 0, 'the approval transaction rechecks the gate under a shared row lock')
  assert.ok(lookup >= 0, 'the draft order is looked up')
  assert.ok(fence < recheck && recheck < lookup, 'fence, recheck, then work — in that order')
})

test('approveChangeOrder refused when Projects disables between the entry guard and the approval', async () => {
  reset()
  fenceState.entryFeatures = { projects: true }
  fenceState.txFeatures = { projects: false }
  const res = await post({ action: 'approveChangeOrder', id: '00000000-0000-4000-8000-00000000c002', approvedOn: '2026-08-31' })
  assert.equal(res.status, 422)
  assert.equal(((await res.json()) as { error: string }).error, 'Projects feature is disabled')
  assert.ok(
    !txTexts().some((t) => t.includes('insert into sov_lines')),
    'a refused approval must never land its SOV line',
  )
})

test('engine and web fences hash the same per-org key', () => {
  // The disable path takes the web fence and the engine creators take the
  // engine fence: identical keys are what make those two locks one serial
  // order instead of two independent locks that never meet.
  for (const orgId of ['org-1', '00000000-0000-4000-8000-000000000000']) {
    assert.equal(engineFenceKey(orgId), webFenceKey(orgId))
  }
  assert.equal(webFenceKey('org-1'), 'openbooks:feature-gate:org-1')
})
