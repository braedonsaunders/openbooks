import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Collection POST can insert isDefault with isActive:false in one write.
// That clears the prior default and then hides the new one from resolve.

const stateKey = Symbol.for('openbooks.form-layout-post-inactive-default-test')
interface DbState {
  statements: unknown[]
}
const dbState: DbState = { statements: [] }
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
  export const RECORD_TYPE_BY_KEY = { vendor_bill: { key: 'vendor_bill' } }
  export function parseFormLayout(input) {
    return { success: true, data: input ?? { schemaVersion: 1, recordType: 'vendor_bill' }, issues: [] }
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
    if (specifier === '@openbooks/engine/src/platform/db.ts' && parent.includes('customization/form-layouts/route')) {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = { execute: (...a) => globalThis[Symbol.for("openbooks.form-layout-post-inactive-default-test")].db.execute(...a), transaction: (...a) => globalThis[Symbol.for("openbooks.form-layout-post-inactive-default-test")].db.transaction(...a) }',
      }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/form-layouts/route')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-form-post-inactive-default` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/form-layouts/route')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-form-post-inactive-default' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-form-post-inactive-default') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-form-post-inactive-default') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-form-post-inactive-default') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { POST } = await import('./route.ts?form-layout-post-inactive-default')

function installDb() {
  const state = (globalThis as Record<symbol, unknown>)[stateKey] as unknown as DbState & {
    db: {
      execute: () => Promise<{ rows: unknown[] }>
      transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
    }
  }
  state.statements = []
  state.db = {
    execute: async () => ({ rows: [] }),
    transaction: async () => {
      state.statements.push('write')
      return { id: '33333333-3333-4333-8333-333333333333', name: 'Hidden' }
    },
  }
}

function post(body: unknown) {
  return POST(
    new Request('http://x/api/customization/form-layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('POST refuses an inactive default before any write', async () => {
  installDb()
  const res = await post({
    recordType: 'vendor_bill',
    name: 'Hidden default',
    isDefault: true,
    isActive: false,
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(String(body.error), /inactive form cannot be the default/i)
  assert.match(String(body.error), /activate it/i)
  assert.equal(dbState.statements.length, 0)
})
