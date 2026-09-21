import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Collection POST used to coerce isDefault with !! — a truthy non-boolean
// (including the string "false") cleared sibling defaults and stored true.
// The handler must refuse that by name and never enter the write transaction.

const stateKey = Symbol.for('openbooks.list-view-post-bool-test')
interface DbState {
  txCalls: number
}
const dbState: DbState = { txCalls: 0 }
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
  export const RECORD_TYPE_BY_KEY = { employee: { key: 'employee' } }
  export function parseListView(input) {
    return { success: true, data: input, issues: [] }
  }
  export function stripSeededDefaultMark(input) {
    return input
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
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = { execute: async () => ({ rows: [] }), transaction: async (fn) => { globalThis[Symbol.for("openbooks.list-view-post-bool-test")].txCalls++; return fn({ execute: async () => ({ rows: [{ id: "view-1", name: "n" }] }) }) } }',
      }
    }
    if (
      (specifier.endsWith('lib/authz') || specifier.endsWith('lib/customization/gates')) &&
      parent.includes('customization/list-views')
    ) {
      return { shortCircuit: true, format: 'module', url: `mock:${specifier.endsWith('lib/authz') ? 'authz' : 'gates'}-post-flags` }
    }
    if (specifier === '@openbooks/customization' && parent.includes('customization/list-views')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-post-flags' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:authz-post-flags') return { format: 'module', source: mockAuthz, shortCircuit: true }
    if (url === 'mock:gates-post-flags') return { format: 'module', source: mockGates, shortCircuit: true }
    if (url === 'mock:customization-post-flags') return { format: 'module', source: mockCustomization, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const list_view_post_flagsUrl = './route.ts?list-view-post-flags'
const { POST } = await import(list_view_post_flagsUrl)

const config = { schemaVersion: 1, recordType: 'employee' }

function postRequest(body: unknown): Request {
  return new Request('http://x/api/customization/list-views', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST refuses a non-boolean isDefault by name and writes nothing', async () => {
  for (const value of ['false', 'yes', 1, {}] as const) {
    dbState.txCalls = 0
    const res = await POST(
      postRequest({ recordType: 'employee', name: 'View', scope: 'org', config, isDefault: value }),
    )
    assert.equal(res.status, 400, `status for ${JSON.stringify(value)}`)
    assert.equal((await res.json()).error, 'isDefault must be a boolean')
    assert.equal(dbState.txCalls, 0, 'rejected create must not enter the write transaction')
  }
})

test('POST still accepts an omitted or real-boolean isDefault', async () => {
  for (const value of [undefined, false, true] as const) {
    dbState.txCalls = 0
    const body =
      value === undefined
        ? { recordType: 'employee', name: 'View', scope: 'org', config }
        : { recordType: 'employee', name: 'View', scope: 'org', config, isDefault: value }
    const res = await POST(postRequest(body))
    assert.equal(res.status, 200, `status for ${String(value)}`)
    assert.equal(dbState.txCalls, 1)
  }
})
