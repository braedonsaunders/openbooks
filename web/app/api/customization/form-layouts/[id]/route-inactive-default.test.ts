import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Route-level proof that form-layouts PATCH refuses next-state default+inactive
// before any write. The database is stubbed (never validation).

const stateKey = Symbol.for('openbooks.form-layout-inactive-default-test')
interface DbState {
  loadRow: Record<string, unknown> | null
  statements: unknown[]
}
const dbState: DbState = { loadRow: null, statements: [] }
;(globalThis as Record<symbol, unknown>)[stateKey] = dbState

const mockAuthz = `
  export async function guardPermission() {
    return { user: { orgId: 'org-1', id: 'user-1' } }
  }
`
const mockGates = `
  export async function refuseDisabledRecordType() {
    return null
  }
`
const mockCustomization = `
  export function parseFormLayout() {
    return { success: true, data: { schemaVersion: 1, recordType: 'vendor_bill' }, issues: [] }
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
    if (specifier === '@openbooks/engine/src/platform/db.ts' && parent.includes('customization/form-layouts')) {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.form-layout-inactive-default-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.form-layout-inactive-default-test")].db.transaction(...a) }',
      }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/form-layouts')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-form-inactive-default` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/form-layouts')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-form-inactive-default' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-form-inactive-default') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-form-inactive-default') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-form-inactive-default') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { PATCH } = await import('./route.ts?form-layout-inactive-default')

const LAYOUT_ID = '22222222-2222-4222-8222-222222222222'

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

function layoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LAYOUT_ID,
    recordType: 'vendor_bill',
    name: 'Standard',
    description: null,
    isDefault: false,
    isActive: true,
    allowedRoles: null,
    layout: { schemaVersion: 1, recordType: 'vendor_bill' },
    ...overrides,
  }
}

function patch(body: unknown) {
  return PATCH(
    new Request(`http://x/api/customization/form-layouts/${LAYOUT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: LAYOUT_ID }) },
  )
}

test('PATCH refuses isDefault+inactive before any write', async () => {
  installDb(layoutRow())
  const res = await patch({ isDefault: true, isActive: false })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(String(body.error), /inactive form cannot be the default/i)
  assert.match(String(body.error), /activate it/i)
  assert.match(String(body.error), /unset default before deactivating/i)
  assert.equal(dbState.statements.length, 0)
})

test('PATCH refuses deactivating a form that remains the default', async () => {
  installDb(layoutRow({ isDefault: true, isActive: true }))
  const res = await patch({ isActive: false })
  assert.equal(res.status, 400)
  assert.match(String((await res.json()).error), /inactive form cannot be the default/i)
  assert.equal(dbState.statements.length, 0)
})
