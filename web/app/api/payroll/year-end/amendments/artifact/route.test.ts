import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * GET year-end/amendments/artifact?id= — the submission id is a UUID column.
 * A 36-character hex/dash string is not enough: PostgreSQL still raises
 * `invalid input syntax for type uuid` for values the old `/^[0-9a-f-]{36}$/i`
 * accepted (36 hex digits, 36 dashes). Shape refusals stay 422 and never
 * reach the database — the same class as the year-end year window.
 */
const stateKey = Symbol.for('openbooks.payroll-year-end-artifact-test')
interface RouteState { dbCalls: number }
const state: RouteState = { dbCalls: 0 }
;(globalThis as Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:subsidiary-scope',
    `
      export async function guardPayrollFilingRowIds() { return null }
      export async function guardPayrollFilingData() { return null }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-year-end-artifact-test')]
      export const db = {
        execute() {
          state.dbCalls += 1
          throw new Error('invalid input syntax for type uuid: malformed id reached PostgreSQL')
        },
      }
    `,
  ],
  [
    'mock:drizzle',
    `
      export function sql() { return {} }
    `,
  ],
  [
    'mock:amendments',
    `
      export async function filingArtifact() {
        throw new Error('filingArtifact must not run for a shape refusal')
      }
    `,
  ],
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() { return [] }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/payroll/yearend-amendments.ts', 'mock:amendments'],
  ['@openbooks/engine/src/payroll/yearend.ts', 'mock:yearend'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const routeUrl = './route.ts?payroll-year-end-artifact-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end/amendments/artifact${query}`))
}

test('a 36-character hex blob is refused as a malformed id before PostgreSQL', async () => {
  // 36 hex digits — length-and-charset match the old guard, not a UUID.
  const id = '0123456789abcdef0123456789abcdef0123'
  assert.equal(id.length, 36)
  state.dbCalls = 0
  const response = await get(`?id=${id}`)
  assert.equal(response.status, 422, await response.clone().text())
  const error = (await response.json() as { error: string }).error
  assert.match(error, /UUID/)
  assert.match(error, /0123456789abcdef0123456789abcdef0123/)
  assert.equal(state.dbCalls, 0, 'a shape refusal must not bind the id as uuid')
})

test('36 dashes are refused as a malformed id, not as a missing id', async () => {
  const id = '-'.repeat(36)
  state.dbCalls = 0
  const response = await get(`?id=${encodeURIComponent(id)}`)
  assert.equal(response.status, 422, await response.clone().text())
  const error = (await response.json() as { error: string }).error
  assert.match(error, /UUID/)
  assert.match(error, /------------------------------------/)
  assert.doesNotMatch(error, /required/)
  assert.equal(state.dbCalls, 0)
})

test('an absent id names that it is required, and never reaches the database', async () => {
  state.dbCalls = 0
  const response = await get('')
  assert.equal(response.status, 422)
  assert.match((await response.json() as { error: string }).error, /required/)
  assert.equal(state.dbCalls, 0)
})
