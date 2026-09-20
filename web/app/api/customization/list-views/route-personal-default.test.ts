import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Promoting a personal default must take the scope advisory lock before the
// insert. Without it, two concurrent POSTs both unset zero rows and both
// persist is_default=true — overlapping configuration no resolve can pick.

const stateKey = Symbol.for('openbooks.list-view-personal-default-post-test')
interface DbState {
  statements: unknown[]
  defaultCount: number
}
const dbState: DbState = { statements: [], defaultCount: 1 }
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
    if (specifier.startsWith('@/')) {
      return nextResolve(
        new URL(`../../../../../web/${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      )
    }
    const parent = context.parentURL ?? ''
    if (specifier === '@openbooks/engine/src/platform/db.ts' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.list-view-personal-default-post-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.list-view-personal-default-post-test")].db.transaction(...a) }' }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/list-views')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-personal-default` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-personal-default' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-personal-default') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-personal-default') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-personal-default') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { SQL } = await import('drizzle-orm')
const { POST } = await import('./route.ts')

function haystack(statements: unknown[]): string {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (node == null) return
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      parts.push(String(node))
      return
    }
    if (typeof node !== 'object') return
    if (node instanceof SQL) {
      for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) visit(chunk)
      return
    }
    if ('value' in node) visit((node as { value: unknown }).value)
    else for (const value of Object.values(node)) visit(value)
  }
  for (const statement of statements) visit(statement)
  return parts.join(' ')
}

function installDb() {
  const state = (globalThis as Record<symbol, unknown>)[stateKey] as unknown as DbState & {
    db: { execute: () => Promise<{ rows: unknown[] }>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
  }
  state.statements = []
  state.defaultCount = 1
  state.db = {
    execute: async () => ({ rows: [] }),
    transaction: async (fn) => {
      const tx = {
        execute: async (query: unknown) => {
          state.statements.push(query)
          const text = haystack([query])
          if (/count\(\*\)/.test(text)) return { rows: [{ n: state.defaultCount }] }
          return { rows: [{ id: '99999999-9999-4999-8999-999999999999', name: 'Mine' }] }
        },
      }
      return fn(tx)
    },
  }
}

const viewBody = {
  recordType: 'employee',
  name: 'Mine',
  scope: 'user',
  config: { schemaVersion: 1, recordType: 'employee', columns: [], filters: [], sort: { column: 'display_name', dir: 'asc' }, perPage: 25 },
}

test('POST of a personal default locks the owner scope before insert', async () => {
  installDb()
  const res = await POST(
    new Request('http://x/api/customization/list-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...viewBody, isDefault: true }),
    }),
  )
  assert.equal(res.status, 200)
  const text = haystack(dbState.statements)
  assert.match(text, /pg_advisory_xact_lock/)
  assert.match(text, /list-view-default:org-1:user:user-1:employee/)
  const lockAt = text.indexOf('pg_advisory_xact_lock')
  const insertAt = text.indexOf('insert into list_views')
  assert.ok(lockAt >= 0 && insertAt >= 0 && lockAt < insertAt, 'the scope lock must precede the insert')
})

test('POST refuses a personal default when the write would leave two defaults', async () => {
  installDb()
  dbState.defaultCount = 2
  const res = await POST(
    new Request('http://x/api/customization/list-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...viewBody, isDefault: true }),
    }),
  )
  assert.equal(res.status, 409)
  assert.match(String((await res.json()).error), /default/i)
})
