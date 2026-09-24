import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary regression for the project subsidiary write fence. The fake
// database treats a scoped query as the database would for an out-of-scope
// project: the locked compare-and-swap read yields no rows, so no override
// write or schedule sync runs.
const stateKey = Symbol.for('openbooks.percent-complete-route-test')
interface DbCall { kind: 'tx-execute'; text: string }
interface SyncCall { orgId: string; actorId: string; asOfDate: string; projectId: string }
interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  calls: DbCall[]
  syncCalls: SyncCall[]
  respondTxExecute: (text: string) => { rows: unknown[] }
  syncSkipped: string | null
}

const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  calls: [],
  syncCalls: [],
  respondTxExecute: () => ({ rows: [] }),
  syncSkipped: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into its raw text for query assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksPercentCompleteSqlText?: unknown }).openbooksPercentCompleteSqlText = sqlText

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
      class Query {
        constructor(text) { this.queryChunks = [text] }
      }
      function render(value) {
        return value instanceof Query ? value.queryChunks.join('') : String(value)
      }
      export function sql(strings, ...values) {
        let text = ''
        for (let i = 0; i < strings.length; i += 1) {
          text += strings[i]
          if (i < values.length) text += render(values[i])
        }
        return new Query(text)
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.percent-complete-route-test')]
      const sqlText = globalThis.openbooksPercentCompleteSqlText
      export const db = {
        transaction: async (work) => work({
          execute: (query) => {
            const text = sqlText(query)
            state.calls.push({ kind: 'tx-execute', text })
            if (text.includes('from orgs') && text.includes('for share')) {
              return Promise.resolve({ rows: [{ features: { projects: true } }] })
            }
            return Promise.resolve(state.respondTxExecute(text))
          },
        }),
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
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
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.percent-complete-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'projects.manage') return new Response(null, { status: 403 })
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  ['mock:projects-gate', `export async function guardProjectsFeature() { return null }`],
  [
    'mock:subsidiaries',
    `
      import { sql } from 'drizzle-orm'
      export function subsidiaryVisibleFilter(column, allowed) {
        if (allowed === null) return sql\`\`
        const ids = [...allowed]
        return ids.length
          ? sql\` and \${column} = any(\${\`{\${ids.join(',')}}\`}::uuid[])\`
          : sql\` and false\`
      }
    `,
  ],
  [
    'mock:project-revenue',
    `
      const state = globalThis[Symbol.for('openbooks.percent-complete-route-test')]
      export async function syncProjectRevenueContractsInTransaction(_tx, orgId, actorId, asOfDate, projectId) {
        state.syncCalls.push({ orgId, actorId, asOfDate, projectId })
        // Like the engine: a skipped sync synced nothing.
        return {
          synced: state.syncSkipped
            ? []
            : [{ projectId, projectCode: 'P-1', contractId: 'contract-1', obligationId: 'obligation-1', contractValue: '100.00', percentComplete: '37.5000', overridden: true, created: false }],
          problems: [],
          skipped: state.syncSkipped,
        }
      }
    `,
  ],
  ['mock:business-date', `export async function businessToday() { return '2026-08-28' }`],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['next/server', 'mock:next-server'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/projects/revenue.ts', 'mock:project-revenue'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/projects-gate', 'mock:projects-gate'],
  ['../../../../../lib/subsidiaries', 'mock:subsidiaries'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { format: 'module', shortCircuit: true, url: 'mock:server-only' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?percent-complete-subsidiary-scope-test'
const { PUT } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const VISIBLE_SUBSIDIARY_ID = '00000000-0000-4000-8000-000000000002'

function reset(): void {
  routeState.allowedSubsidiaryIds = null
  routeState.calls.length = 0
  routeState.syncCalls.length = 0
  routeState.respondTxExecute = () => ({ rows: [] })
  routeState.syncSkipped = null
}

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new Request(`http://openbooks.test/api/projects/${PROJECT_ID}/percent-complete`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROJECT_ID }) },
  )
}

test('PUT refuses an out-of-scope project before changing its override or schedule', async () => {
  reset()
  routeState.allowedSubsidiaryIds = new Set([VISIBLE_SUBSIDIARY_ID])
  // Out of scope: every scoped read and write yields no rows, so the locked
  // compare-and-swap read refuses before any write or sync runs.
  routeState.respondTxExecute = () => ({ rows: [] })

  const response = await put({ percentComplete: 55, expectedPercentComplete: null })

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(routeState.syncCalls.length, 0, 'revenue schedule sync never ran for a hidden project')
  const guard = routeState.calls.find((call) => call.text.includes('for update'))
  assert.ok(guard, 'the guarded locked read ran')
  assert.match(guard.text, /subsidiary_id\s*=\s*any/, 'the locked read carries the caller subsidiary scope')
  assert.equal(
    routeState.calls.some((call) => call.text.includes('update projects')),
    false,
    'no override write ran for a hidden project',
  )
})

test('PUT updates an in-scope project and rebuilds its schedule', async () => {
  reset()
  routeState.allowedSubsidiaryIds = new Set([VISIBLE_SUBSIDIARY_ID])
  routeState.respondTxExecute = (text) =>
    text.includes('update projects')
      ? { rows: [{ id: PROJECT_ID }] }
      : text.includes('percentCompleteOverride')
        ? { rows: [{ override: null }] }
        : { rows: [] }

  const response = await put({ percentComplete: 37.5, expectedPercentComplete: null })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    status: {
      projectId: PROJECT_ID,
      projectCode: 'P-1',
      contractId: 'contract-1',
      obligationId: 'obligation-1',
      contractValue: '100.00',
      percentComplete: '37.5000',
      overridden: true,
      created: false,
    },
    problems: [],
  })
  assert.deepEqual(routeState.syncCalls, [{
    orgId: 'org-1',
    actorId: 'user-1',
    asOfDate: '2026-08-28',
    projectId: PROJECT_ID,
  }])
})

test('PUT surfaces a skipped revenue sync as a named warning, not a silent no-op', async () => {
  reset()
  routeState.allowedSubsidiaryIds = new Set([VISIBLE_SUBSIDIARY_ID])
  routeState.respondTxExecute = (text) =>
    text.includes('update projects')
      ? { rows: [{ id: PROJECT_ID }] }
      : text.includes('percentCompleteOverride')
        ? { rows: [{ override: null }] }
        : { rows: [] }
  routeState.syncSkipped = 'project revenue sync skipped: the Projects feature is off — turn it on in Company Settings → Features to recognize project progress'

  const response = await put({ percentComplete: 37.5, expectedPercentComplete: null })

  assert.equal(response.status, 200)
  const body = (await response.json()) as { status: unknown; problems: string[] }
  assert.equal(body.status, null)
  assert.deepEqual(body.problems, [routeState.syncSkipped])
})
