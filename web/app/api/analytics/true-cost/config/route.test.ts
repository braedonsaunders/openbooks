import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface RouteState {
  revision: number
  executed: string[]
  updateResponses: ({ rows: unknown[] })[]
  allowedSubsidiaryIds: Set<string> | null
}

const stateKey = Symbol.for('openbooks.true-cost-config-route-test')
const state: RouteState = { revision: 0, executed: [], updateResponses: [], allowedSubsidiaryIds: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its template text for query assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksTrueCostSqlText = sqlText

const profile = {
  id: 'profile-1',
  name: 'Default',
  color: '#3b82f6',
  compositeMethod: 'sum',
  baseLaborRate: 50,
  fringeRate: 0.25,
  categorySettings: {},
  customCategories: [],
  baseOverrides: {},
}

const mockSources = new Map<string, string>([
  [
    'mock:gates',
    `
      export async function guardFeaturePermission() {
        const state = globalThis[Symbol.for('openbooks.true-cost-config-route-test')]
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
    `,
  ],
  [
    'mock:data',
    `
      export const DEFAULT_PROFILE = ${JSON.stringify(profile)}
    `,
  ],
  [
    'mock:engine',
    `
      export const ALLOCATION_BASES = { billed_hours: {}, total_hours: {}, labor_dollars: {}, headcount: {}, revenue: {}, direct_cost: {}, square_feet: {}, units: {}, custom: {} }
      export const ALLOCATION_METHODS = { simple: {}, weighted: {}, stepped: {} }
      export const RATE_FORMATS = { per_hour: {}, percent_labor: {}, percent_cost: {}, per_fte: {}, per_unit: {} }
      export const COMPOSITE_METHODS = { sum: {}, weighted: {}, cascading: {} }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.true-cost-config-route-test')]
      const sqlText = globalThis.openbooksTrueCostSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (text.includes("select settings -> 'analytics' -> 'trueCost' as cfg")) {
            return { rows: [{ cfg: { revision: String(state.revision), activeProfileId: 'profile-1', profiles: [${JSON.stringify(profile)}] } }] }
          }
          if (text.includes('returning settings')) {
            const response = state.updateResponses.length
              ? state.updateResponses.shift()
              : { rows: [{ revision: String(state.revision + 1) }] }
            if (response.rows.length) state.revision += 1
            return response
          }
          throw new Error('unexpected database query: ' + text)
        },
      }
    `,
  ],
])

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles of validation and money cannot produce the refusals
// the real modules enforce, so every bad-body and bad-amount case behind
// them reported green untested.
const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', 'mock:gates'],
  ['../../../../../lib/analytics/true-cost-data', 'mock:data'],
  ['../../../../../lib/analytics/true-cost-engine', 'mock:engine'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
])
let realAuthzUrl = ''
let dbRealUrl = ''

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    if (specifier === '../../../../../lib/authz') {
      realAuthzUrl = nextResolve(specifier, context).url
      return { url: 'mock:authz', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      dbRealUrl = nextResolve(specifier, context).url
      return { url: 'mock:db', shortCircuit: true }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source: url === 'mock:db' ? `export * from ${JSON.stringify(dbRealUrl)};\n${source}` : source, shortCircuit: true }
    if (url === 'mock:authz') return { format: 'module', source: `export { guardUnrestrictedScope } from ${JSON.stringify(realAuthzUrl)}`, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?true-cost-config-occ-test'
const { GET, PUT } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(revision: number): void {
  state.revision = revision
  state.executed = []
  state.updateResponses = []
  state.allowedSubsidiaryIds = null
}

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new Request('http://openbooks.test/api/analytics/true-cost/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('GET exposes the persisted configuration revision', async () => {
  reset(7)

  const response = await GET()

  assert.equal(response.status, 200)
  assert.equal((await response.json()).revision, 7)
  assert.ok(state.executed.some((query) => query.includes("-> 'trueCost' as cfg")))
})

test('PUT rejects a missing revision before attempting a write', async () => {
  reset(3)

  const response = await put({ profiles: [profile] })

  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /revision is required/)
  assert.equal(state.executed.length, 0)
})

test('restricted actors cannot write org-wide True Cost settings', async () => {
  reset(3)
  state.allowedSubsidiaryIds = new Set(['subsidiary-a'])
  const response = await put({ expectedRevision: 3, activeProfileId: profile.id, profiles: [profile] })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(state.executed.length, 0)
})

test('two PUTs from one read cannot both commit the whole configuration', async () => {
  reset(4)
  // The first writer wins the row-level compare-and-swap; the stale writer
  // receives no RETURNING row and must surface a conflict.
  state.updateResponses = [{ rows: [{ revision: '5' }] }, { rows: [] }]
  const body = { expectedRevision: 4, activeProfileId: profile.id, profiles: [profile] }

  const [winner, loser] = await Promise.all([put(body), put(body)])

  assert.equal(winner.status, 200)
  assert.equal((await winner.json()).revision, 5)
  assert.equal(loser.status, 409)
  assert.match((await loser.json()).error, /changed after you opened it/)
  const update = state.executed.find((query) => query.includes('returning settings'))
  assert.ok(update, 'the write uses UPDATE ... RETURNING to detect a lost compare-and-swap')
  assert.match(update!, /coalesce\(settings -> 'analytics' -> 'trueCost' ->> 'revision', '0'\)/)
})
