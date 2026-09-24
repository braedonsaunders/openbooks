import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

// F3-22, server side: recording a filing as filed, issuing an amendment
// and cancelling a slip are statutory acts behind POST
// /api/payroll/year-end/amendments, so the route must demand payroll.run —
// a read-only caller (payroll.read) is refused before the engine is
// reached. Reading the history (GET) stays payroll.read: wage data a
// read-only caller may see. Driven through the real route with a recording
// guard mock and an independent expected value — the permission string the
// route passes, and a 403 with no engine write when the guard refuses.

interface RecordedIssue {
  revision: string
  rowIds?: readonly string[]
}

interface RouteState {
  issues: RecordedIssue[]
}

const stateKey = Symbol.for('openbooks.payroll-amendments-permission-test')
const state: RouteState = { issues: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const callsKey = Symbol.for('openbooks.payroll-amendments-permission-calls')
const calls: Array<[string, string]> = []
;(globalThis as typeof globalThis & Record<symbol, unknown>)[callsKey] = calls

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission(permission, feature) {
        globalThis[Symbol.for('openbooks.payroll-amendments-permission-calls')].push([permission, feature])
        const refusal = globalThis.__filingPermissionRefusal ?? null
        if (refusal) return refusal
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:subsidiary-scope',
    `
      export class FilingScopeDenied {
        constructor(response) {
          this.response = response
        }
      }
      export async function guardPayrollFilingRowIds() { return null }
      export async function guardPayrollFilingData() { return null }
    `,
  ],
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() { return [] }
    `,
  ],
  [
    'mock:db',
    `
      export const db = { execute: async () => ({ rows: [] }) }
    `,
  ],
  [
    'mock:drizzle',
    `
      export function sql() { return {} }
    `,
  ],
  [
    'mock:packs',
    `
      export class PayrollPackError extends Error {}
    `,
  ],
  [
    'mock:payroll-error',
    `
      export class PayrollError extends Error {}
    `,
  ],
  [
    'mock:amendments',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-amendments-permission-test')]
      export async function filingLifecycle() { return { submissions: [], rows: [] } }
      export async function recordFilingIssue(input) {
        state.issues.push(input)
        return {
          submission: {
            id: 'submission-1', revision: input.revision, revisionNumber: 2,
            issuedAt: '2026-08-28T00:00:00.000Z', slipCount: 1, artifact: null,
          },
          file: null, fileRefusal: null, corrections: [],
        }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/payroll/packs.ts', 'mock:packs'],
  ['@openbooks/engine/src/payroll/error.ts', 'mock:payroll-error'],
  ['@openbooks/engine/src/payroll/yearend.ts', 'mock:yearend'],
  ['@openbooks/engine/src/payroll/yearend-amendments.ts', 'mock:amendments'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real @/lib/api/json is used (no hand double of the protected
    // surface); only its 'server-only' marker is shimmed, the same cut the
    // mock-surface checker itself makes — it carries no behaviour.
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payroll-amendments-permission-test'
const { POST, GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.issues.length = 0
  calls.length = 0
  ;(globalThis as Record<string, unknown>).__filingPermissionRefusal = null
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/payroll/year-end/amendments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        country: 'CA',
        filing: 't4',
        year: 2026,
        rowIds: ['row-1'],
        ...body,
      }),
    }),
  )
}

test('issuing a filing demands payroll.run, not payroll.read', async () => {
  reset()
  const response = await post({ revision: 'original', note: 'filed' })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['payroll.run', 'payroll']])
  assert.equal(state.issues.length, 1)
})

test('a refused caller never reaches the engine', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__filingPermissionRefusal = NextResponse.json(
    { error: 'payroll.run is required' },
    { status: 403 },
  )
  const response = await post({ revision: 'original', note: 'filed' })
  assert.equal(response.status, 403)
  assert.deepEqual(state.issues, [])
})

test('reading the filing history stays payroll.read', async () => {
  reset()
  const response = await GET(
    new Request('http://openbooks.test/api/payroll/year-end/amendments?country=CA&filing=t4&year=2026'),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['payroll.read', 'payroll']])
})
