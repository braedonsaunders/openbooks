/**
 * Queue item 34: input-shape refusals inside the payroll scope guards must be
 * actor-independent. `guardPayrollFilingRowIds` used to short-circuit
 * unrestricted callers BEFORE parsing the row ids, so the most privileged
 * user was the one whose malformed input reached the database untested
 * (a database error — the wrong error class). The parse now runs first, for
 * every caller, and answers 422; scope refusals stay a uniform 404.
 *
 * Unit partition: the database and the authz helpers are mocked because the
 * assertions never reach them — a shape refusal that needed a database would
 * be the defect.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const mockSources = new Map<string, string>([
  ['mock:db', `
    export const db = { execute: async () => { throw new Error('the database must not be reached for a shape refusal') } }
  `],
  ['mock:yearend', `
    export async function roeSourceScope() { throw new Error('roeSourceScope must not be reached for a shape refusal') }
  `],
  ['mock:authz', `
    export function guardSubsidiaryScope() { return null }
    export function subsidiaryScopeAllows() { return true }
  `],
  ['mock:subsidiaries', `
    export function subsidiaryVisibleFilter() { return null }
  `],
])
const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payroll/yearend.ts', 'mock:yearend'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../lib/subsidiaries', 'mock:subsidiaries'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (context.parentURL?.startsWith('mock:')) return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})
const scopeUrl = './subsidiary-scope.ts?item-34-shape'
const { guardPayrollFilingRowIds } = (await import(scopeUrl)) as typeof import('./subsidiary-scope')
hooks.deregister()

const user = { orgId: 'org-1', id: 'user-1' }
const unrestricted = { user, allowedSubsidiaryIds: null } as unknown as Parameters<typeof guardPayrollFilingRowIds>[0]
const restricted = { user, allowedSubsidiaryIds: ['sub-1'] } as unknown as Parameters<typeof guardPayrollFilingRowIds>[0]
const EMPLOYEE = '5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

test('a malformed row id is refused as malformed input for an UNRESTRICTED caller (it used to pass straight through)', async () => {
  const response = await guardPayrollFilingRowIds(unrestricted, 'CA', 't4', ['not-a-row-id'], 2026)
  assert.ok(response, 'unrestricted callers no longer skip the shape check')
  assert.equal(response.status, 422)
  assert.match(((await response.json()) as { error: string }).error, /row ids must match the CA\/t4 row grammar/)
})

test('the same malformed row id is 422 for a restricted caller — shape, not scope', async () => {
  const response = await guardPayrollFilingRowIds(restricted, 'CA', 't4', ['not-a-row-id'], 2026)
  assert.ok(response)
  assert.equal(response.status, 422, 'a shape error is not disguised as a scope 404')
})

test('an undeclared filing is refused before the actor is consulted', async () => {
  for (const gate of [unrestricted, restricted]) {
    const response = await guardPayrollFilingRowIds(gate, 'CA', 'no-such-filing', [`${EMPLOYEE}:ON:`], 2026)
    assert.ok(response)
    assert.equal(response.status, 404)
  }
})

test('a well-formed row id lets an unrestricted caller through without touching the database', async () => {
  const response = await guardPayrollFilingRowIds(unrestricted, 'CA', 't4', [`${EMPLOYEE}:ON:`], 2026)
  assert.equal(response, null)
})
