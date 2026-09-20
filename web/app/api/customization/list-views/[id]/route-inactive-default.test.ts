import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Route-level proof that list-views PATCH refuses next-state default+inactive
// before any write. The database is stubbed (never validation): a write would
// increment statements. resolveListView only reads is_active rows.

const stateKey = Symbol.for('openbooks.list-view-inactive-default-test')
interface DbState {
  loadRow: Record<string, unknown> | null
  statements: unknown[]
}
const dbState: DbState = { loadRow: null, statements: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = dbState

const mockAuthz = `
  export async function getAuthz() {
    return { user: { orgId: 'org-1', id: 'user-1' } }
  }
  export function can() {
    return true
  }
`
const mockGates = `
  export async function refuseDisabledRecordType() {
    return null
  }
`
const mockCustomization = `
  export function parseListView() {
    return { success: true, data: { schemaVersion: 1, recordType: 'vendor_bill' }, issues: [] }
  }
  export function stripSeededDefaultMark(config) {
    return config
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
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.list-view-inactive-default-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.list-view-inactive-default-test")].db.transaction(...a) }',
      }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/list-views')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-inactive-default` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-inactive-default' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-inactive-default') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-inactive-default') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-inactive-default') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?list-view-inactive-default'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

function installDb(loadRow: Record<string, unknown>) {
  const state = (globalThis as Record<symbol, unknown>)[stateKey] as unknown as DbState & {
    db: {
      execute: (query: unknown) => Promise<{ rows: unknown[] }>
      transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
    }
  }
  state.loadRow = loadRow
  state.statements = []
  state.db = {
    execute: async () => ({ rows: state.loadRow ? [state.loadRow] : [] }),
    transaction: async () => {
      state.statements.push('write')
      return undefined
    },
  }
}

function viewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VIEW_ID,
    recordType: 'vendor_bill',
    name: 'My bills',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: false,
    isActive: true,
    config: { schemaVersion: 1, recordType: 'vendor_bill' },
    ...overrides,
  }
}

function patch(body: unknown) {
  return PATCH(
    new Request(`http://x/api/customization/list-views/${VIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )
}

test('PATCH refuses isDefault+inactive before any write', async () => {
  installDb(viewRow())
  const res = await patch({ isDefault: true, isActive: false })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(String(body.error), /inactive view cannot be the default/i)
  assert.match(String(body.error), /activate it/i)
  assert.match(String(body.error), /unset default before deactivating/i)
  assert.equal(dbState.statements.length, 0)
})

test('PATCH refuses deactivating a view that remains the default', async () => {
  installDb(viewRow({ isDefault: true, isActive: true }))
  const res = await patch({ isActive: false })
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /inactive view cannot be the default/i)
  assert.equal(dbState.statements.length, 0)
})

test('PATCH refuses promoting an inactive view to default', async () => {
  installDb(viewRow({ isDefault: false, isActive: false }))
  const res = await patch({ isDefault: true })
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /inactive view cannot be the default/i)
  assert.equal(dbState.statements.length, 0)
})
