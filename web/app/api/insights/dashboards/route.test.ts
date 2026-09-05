import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite: two overlapping PATCH requests exercise the same row
// lock and exact revision fence production uses for dashboard autosave.
const stateKey = Symbol.for('openbooks.dashboard-route-test')
interface DbCall {
  kind: 'execute' | 'tx-execute'
  text: string
}
interface Dashboard {
  id: string
  name: string
  description: string | null
  layout: unknown[]
  status: 'draft' | 'published'
  allowed_roles: string[] | null
  updated_at: string
}
interface RouteState {
  calls: DbCall[]
  dashboard: Dashboard | null
  revision: string
  nextRevision: string
  lockCount: number
  respondExecute: (text: string) => { rows: unknown[] } | Promise<{ rows: unknown[] }>
  respondTxExecute: (text: string) => { rows: unknown[] } | Promise<{ rows: unknown[] }>
}
const routeState: RouteState = {
  calls: [],
  dashboard: null,
  revision: '2026-08-24T12:00:00.100001Z',
  nextRevision: '2026-08-24T12:00:00.100002Z',
  lockCount: 0,
  respondExecute: () => ({ rows: [] }),
  respondTxExecute: () => ({ rows: [] }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into raw text for deterministic fake replies. */
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextDashboard?: unknown }).openbooksSqlTextDashboard = sqlText

const mockSources = new Map<string, string>([
  ['mock:mutations', `
    import { db } from '@openbooks/engine/src/db.ts'
    export async function mutateInsight(_authz, _table, _id, _action, work) {
      return db.transaction ? db.transaction(tx => work(tx, null)) : work(db, null)
    }
  `],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.dashboard-route-test')]
      const sqlText = globalThis.openbooksSqlTextDashboard
      const record = (kind, query) => {
        const text = sqlText(query)
        state.calls.push({ kind, text })
        const respond = kind === 'tx-execute' ? state.respondTxExecute : state.respondExecute
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
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission === 'insights.read' || permission === 'insights.create') {
          return { user: { orgId: 'org-1', id: 'user-1' } }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
  [
    'mock:dashboard-lib',
    `
      const state = globalThis[Symbol.for('openbooks.dashboard-route-test')]
      export async function loadDashboard() { return state.dashboard }
      export function normalizeLayout(value) { return Array.isArray(value) ? value : [] }
      export function normalizeAllowedRoles(value) { return value }
      export function strOrNull(value) { return typeof value === 'string' && value.trim() ? value.trim() : null }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/insight-mutations', 'mock:mutations'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../_lib', 'mock:dashboard-lib'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './[id]/route.ts?dashboard-occ-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./[id]/route.ts')
hooks.deregister()

const DASHBOARD_ID = '00000000-0000-4000-8000-00000000d001'

function reset(): void {
  routeState.calls.length = 0
  routeState.revision = '2026-08-24T12:00:00.100001Z'
  routeState.nextRevision = '2026-08-24T12:00:00.100002Z'
  routeState.dashboard = {
    id: DASHBOARD_ID,
    name: 'Original dashboard',
    description: null,
    layout: [],
    status: 'draft',
    allowed_roles: null,
    updated_at: routeState.revision,
  }
  routeState.lockCount = 0
  routeState.respondExecute = (text) =>
    text.includes('updatedAt') ? { rows: [{ updatedAt: routeState.revision }] } : { rows: [] }
  routeState.respondTxExecute = (text) => {
    if (text.includes('for update')) return { rows: [{ updatedAt: routeState.revision }] }
    if (text.includes('update insight_dashboards')) {
      routeState.revision = routeState.nextRevision
      if (routeState.dashboard) {
        routeState.dashboard = { ...routeState.dashboard, updated_at: routeState.revision }
      }
    }
    return { rows: text.includes('update insight_dashboards') && routeState.dashboard ? [routeState.dashboard] : [] }
  }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/insights/dashboards/${DASHBOARD_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: DASHBOARD_ID }) },
  )
}

test('PATCH rejects a missing revision token before any write', async () => {
  reset()

  const response = await patch({ name: 'No token' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the dashboard revision is required; reload and review the latest revision',
  })
  assert.ok(!routeState.calls.some((call) => call.kind === 'tx-execute'), 'no transactional write ran')
})

test('overlapping saves commit the fresh request and reject the delayed stale request', async () => {
  reset()
  const storedRevision = routeState.revision
  let releaseStaleLock!: () => void
  let staleLockEntered!: () => void
  const staleLock = new Promise<void>((resolve) => {
    releaseStaleLock = resolve
  })
  const entered = new Promise<void>((resolve) => {
    staleLockEntered = resolve
  })
  routeState.respondTxExecute = async (text) => {
    if (text.includes('for update')) {
      routeState.lockCount += 1
      if (routeState.lockCount === 1) {
        staleLockEntered()
        await staleLock
      }
      return { rows: [{ updatedAt: routeState.revision }] }
    }
    if (text.includes('update insight_dashboards')) {
      routeState.revision = routeState.nextRevision
      if (routeState.dashboard) {
        routeState.dashboard = { ...routeState.dashboard, name: 'Newest edit', updated_at: routeState.revision }
      }
    }
    return { rows: text.includes('update insight_dashboards') && routeState.dashboard ? [routeState.dashboard] : [] }
  }

  const stale = patch({ name: 'Stale edit', expectedUpdatedAt: storedRevision })
  await entered
  const fresh = await patch({ name: 'Newest edit', expectedUpdatedAt: storedRevision })
  assert.equal(fresh.status, 200)
  releaseStaleLock()
  const staleResponse = await stale

  assert.equal(staleResponse.status, 409)
  assert.deepEqual(await staleResponse.json(), {
    error: 'this dashboard changed after you opened it; reload and review the latest revision',
  })
  assert.equal(
    routeState.calls.filter((call) => call.kind === 'tx-execute' && call.text.includes('update insight_dashboards')).length,
    1,
    'the stale request never overwrote the fresh payload',
  )
  assert.equal(routeState.revision, routeState.nextRevision)
})
