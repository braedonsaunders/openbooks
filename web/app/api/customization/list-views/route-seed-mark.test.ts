import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// A collection POST carrying the seed mark must store the config WITHOUT
// it. The parser is deliberately mocked pass-through here, so the ONLY thing
// that can remove the mark is the route's own explicit strip — the test does
// not rely on zod dropping unknown keys. The database and authz are stubbed
// (never validation: the strip function itself is the real one, re-exported
// through the mock).

const stateKey = Symbol.for('openbooks.list-view-mark-strip-post-test')
interface DbState {
  statements: unknown[]
}
const dbState: DbState = { statements: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = dbState

const mockAuthz = `
  export async function getAuthz() {
    return { user: { orgId: 'org-1', id: 'user-1' } }
  }
  export async function can() {
    return true
  }
`
const mockGates = `
  export async function refuseDisabledRecordType() {
    return null
  }
`
// Pass-through parser (unknown keys survive) plus the REAL strip function:
// with this mock, a stored config without the mark proves the route stripped
// it, not the parser. The re-export names the real file by URL because a
// mock: URL cannot be the base for a bare specifier.
const seededViewsUrl = new URL(
  '../../../../../packages/customization/src/seeded-views.ts',
  import.meta.url,
).href
const mockCustomization = `
  export { stripSeededDefaultMark } from '${seededViewsUrl}'
  export const RECORD_TYPE_BY_KEY = { employee: { key: 'employee' } }
  export function parseListView(input) {
    return { success: true, data: input, issues: [] }
  }
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // No root tsconfig maps `@/` (only web/tsconfig does): `@/lib/...` → web/lib.
    if (specifier.startsWith('@/')) {
      return nextResolve(
        new URL(`../../../../../web/${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      )
    }
    const parent = context.parentURL ?? ''
    if (specifier === '@openbooks/engine/src/db.ts' && parent.includes('customization/list-views')) {
      // Late delegation: the route binds `db` at import time, before the
      // test installs its doubles, so the stub forwards on every call.
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.list-view-mark-strip-post-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.list-view-mark-strip-post-test")].db.transaction(...a) }' }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/list-views')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-post` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-post' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-post') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-post') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-post') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { SQL } = await import('drizzle-orm')
const { POST } = await import('./route.ts')

const seedShape = {
  schemaVersion: 1,
  recordType: 'employee',
  columns: [{ key: 'display_name', visible: true, width: null, labelOverride: null }],
  filters: [],
  sort: { column: 'display_name', dir: 'desc' },
  perPage: 25,
}

/** Plain-object chunks with a schemaVersion are the stored configs. */
function storedConfigs(statements: unknown[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (node instanceof SQL) {
      for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) visit(chunk)
      return
    }
    if ((node as object).constructor === Object && (node as Record<string, unknown>).schemaVersion === 1) {
      found.push(node as Record<string, unknown>)
    }
  }
  for (const statement of statements) visit(statement)
  return found
}

function installDb() {
  const state = (globalThis as Record<symbol, unknown>)[stateKey] as unknown as DbState & {
    db: { execute: (query: unknown) => Promise<{ rows: unknown[] }>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  }
  state.statements = []
  state.db = {
    execute: async () => ({ rows: [] }),
    transaction: async (fn) => {
      const tx = {
        execute: async (query: unknown) => {
          state.statements.push(query)
          return { rows: [{ id: '99999999-9999-4999-8999-999999999999', name: 'Default view' }] }
        },
      }
      return fn(tx)
    },
  }
}

// A designer create carrying a marked config (echoed from a seeded row)
// stores it unmarked: recreating the default can never resurrect the mark.
test('POST stores a marked config without the mark', async () => {
  installDb()
  const sent = { ...seedShape, seededDefault: true }
  const res = await POST(
    new Request('http://x/api/customization/list-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordType: 'employee', name: 'Default view', scope: 'org', config: sent, isDefault: true }),
    }),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: '99999999-9999-4999-8999-999999999999', name: 'Default view' })
  const stored = storedConfigs((dbState as DbState).statements)
  assert.equal(stored.length, 1)
  assert.ok(!('seededDefault' in stored[0]!), 'the stored config must not carry the seed mark')
  assert.deepEqual(stored[0]!.sort, { column: 'display_name', dir: 'desc' })
})
