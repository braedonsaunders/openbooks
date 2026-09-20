import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Promoting an existing personal view to default must take the same owner
// advisory lock as collection POST. Two concurrent PATCHes otherwise both
// persist is_default=true.

const stateKey = Symbol.for('openbooks.list-view-personal-default-patch-test')
interface DbState {
  loadRow: Record<string, unknown> | null
  statements: unknown[]
  defaultCount: number
}
const dbState: DbState = { loadRow: null, statements: [], defaultCount: 1 }
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
  '../../../../../../packages/customization/src/seeded-views.ts',
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
        new URL(`../../../../../../web/${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      )
    }
    const parent = context.parentURL ?? ''
    if (specifier === '@openbooks/engine/src/platform/db.ts' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.list-view-personal-default-patch-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.list-view-personal-default-patch-test")].db.transaction(...a) }' }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/list-views')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-personal-default-patch` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-personal-default-patch' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-personal-default-patch') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-personal-default-patch') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-personal-default-patch') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { SQL } = await import('drizzle-orm')
const { PATCH } = await import('./route.ts')

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

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
  state.loadRow = {
    id: VIEW_ID,
    recordType: 'employee',
    name: 'Mine',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: false,
    isActive: true,
    config: { schemaVersion: 1, recordType: 'employee' },
  }
  state.statements = []
  state.defaultCount = 1
  state.db = {
    execute: async () => ({ rows: state.loadRow ? [state.loadRow] : [] }),
    transaction: async (fn) => {
      const tx = {
        execute: async (query: unknown) => {
          state.statements.push(query)
          const text = haystack([query])
          if (/count\(\*\)/.test(text)) return { rows: [{ n: state.defaultCount }] }
          return { rows: [{ id: VIEW_ID, name: 'Mine' }] }
        },
      }
      return fn(tx)
    },
  }
}

test('PATCH of a personal default locks the owner scope before update', async () => {
  installDb()
  const res = await PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
  assert.equal(res.status, 200)
  const text = haystack(dbState.statements)
  assert.match(text, /pg_advisory_xact_lock/)
  assert.match(text, /list-view-default:org-1:user:user-1:employee/)
  const lockAt = text.indexOf('pg_advisory_xact_lock')
  const updateAt = text.indexOf('update list_views set')
  assert.ok(lockAt >= 0 && updateAt >= 0 && lockAt < updateAt, 'the scope lock must precede the update')
})

test('PATCH refuses a personal default when the write would leave two defaults', async () => {
  installDb()
  dbState.defaultCount = 2
  const res = await PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
  assert.equal(res.status, 409)
  assert.match(String((await res.json()).error), /default/i)
})
