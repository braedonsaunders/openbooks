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
  /** Empty means the target UPDATE matched nothing (concurrent delete). */
  updateRows: unknown[]
}
const dbState: DbState = { loadRow: null, statements: [], defaultCount: 1, updateRows: [] }
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
  state.updateRows = [{ id: VIEW_ID }]
  state.db = {
    execute: async () => ({ rows: state.loadRow ? [state.loadRow] : [] }),
    transaction: async (fn) => {
      const tx = {
        execute: async (query: unknown) => {
          state.statements.push(query)
          const text = haystack([query])
          if (/count\(\*\)/.test(text)) return { rows: [{ n: state.defaultCount }] }
          // The target UPDATE (not the sibling-default clear) is the write
          // whose row count decides {ok:true}.
          if (/update list_views set/.test(text) && /returning/.test(text)) {
            return { rows: state.updateRows }
          }
          // FOR UPDATE and other reads must carry the locked row's flags.
          // A stub of {id, name} leaves isActive undefined, and
          // refuseInactiveDefault(isDefault && !isActive) then 400s an
          // isDefault-only PATCH of a live view.
          return { rows: state.loadRow ? [{ ...state.loadRow }] : [] }
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

// loadOwn can still see the row while a concurrent DELETE commits before
// our UPDATE. A zero-row UPDATE is not a save — {ok:true} would badge a
// default no read can observe, after clearing siblings and writing audit.
test('PATCH of a vanished view does not return 200', async () => {
  installDb()
  dbState.updateRows = []
  const res = await PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
  assert.notEqual(res.status, 200, 'a vanished row must not report success')
  assert.equal(res.status, 404)
  const text = haystack(dbState.statements)
  assert.doesNotMatch(text, /audit_log/, 'audit must not run after a zero-row UPDATE')
  assert.doesNotMatch(
    text,
    /is_default = false/,
    'sibling defaults must not be cleared before the target write lands',
  )
})

// resolveListView filters is_active before picking isDefault. Saving
// default+inactive (or deactivating a view that stays default) stores a
// flag no subsequent resolve can observe.
test('PATCH refuses an inactive personal isDefault instead of saving it', async () => {
  installDb()
  const res = await PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true, isActive: false }),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
  assert.notEqual(res.status, 200, 'an inactive personal default must not report success')
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /inactive view cannot be the default/)
  const text = haystack(dbState.statements)
  assert.doesNotMatch(text, /update list_views set/, 'the inactive default must not be written')
  assert.doesNotMatch(text, /audit_log/, 'audit must not run for a refused inactive default')
})

test('PATCH refuses deactivating a personal view that stays default', async () => {
  installDb()
  dbState.loadRow = { ...dbState.loadRow!, isDefault: true, isActive: true }
  const res = await PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
  assert.notEqual(res.status, 200, 'deactivating a default must not report success')
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /unset default before deactivating/)
  const text = haystack(dbState.statements)
  assert.doesNotMatch(text, /update list_views set/, 'the view must not be stored inactive and default')
})
