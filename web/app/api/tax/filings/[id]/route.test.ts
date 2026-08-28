import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

// Route boundary regression for fnd_mtcbmf0b_atofm2: a tax filing snapshot is
// organization-wide, so subsidiary-restricted compliance.file holders must
// never reach the irreversible mark-filed engine call.
interface RouteState {
  permissions: Set<string>
  allowedSubsidiaryIds: Set<string> | null
  parseCalls: number
  engineCalls: Array<{ orgId: string; filingId: string; actorId: string; reference: string | null }>
}

const stateKey = Symbol.for('openbooks.tax-filing-id-route-test')
const routeState: RouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  parseCalls: 0,
  engineCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksTaxFilingIdNextResponse = NextResponse

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const state = globalThis[Symbol.for('openbooks.tax-filing-id-route-test')]
        state.parseCalls += 1
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-id-route-test')]
      const NextResponse = globalThis.openbooksTaxFilingIdNextResponse
      export async function guardPermission(permission) {
        if (!state.permissions.has(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'mock:tax-filing',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-id-route-test')]
      export class TaxFilingError extends Error {
        constructor(code) { super(code); this.code = code }
      }
      export async function markTaxFilingFiled(orgId, filingId, actorId, reference) {
        state.engineCalls.push({ orgId, filingId, actorId, reference })
        return { id: filingId, filedAt: '2026-08-24T00:00:00.000Z' }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['@openbooks/engine/src/tax-filing.ts', 'mock:tax-filing'],
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

const { PATCH } = (await import('./route.ts')) as typeof import('./route.ts')
hooks.deregister()

const FILING_ID = '00000000-0000-4000-8000-00000000f001'

function reset(allowedSubsidiaryIds: Set<string> | null, permissions = ['compliance.file']): void {
  routeState.permissions = new Set(permissions)
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds
  routeState.parseCalls = 0
  routeState.engineCalls.length = 0
}

function patch(body: string): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/tax/filings/${FILING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ id: FILING_ID }) },
  )
}

test('a subsidiary-restricted filer cannot certify the organization-wide snapshot', async () => {
  reset(new Set(['00000000-0000-4000-8000-00000000a001']))

  const response = await patch('this is deliberately not JSON')

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(routeState.parseCalls, 0, 'scope denial settles before request-body parsing')
  assert.deepEqual(routeState.engineCalls, [], 'scope denial never reaches markTaxFilingFiled')
})

test('an unrestricted compliance filer can certify the snapshot', async () => {
  reset(null)

  const response = await patch(JSON.stringify({ filingReference: 'REF-2026-042' }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: FILING_ID,
    filed_at: '2026-08-24T00:00:00.000Z',
  })
  assert.equal(routeState.parseCalls, 1)
  assert.deepEqual(routeState.engineCalls, [{
    orgId: 'org-1',
    filingId: FILING_ID,
    actorId: 'user-1',
    reference: 'REF-2026-042',
  }])
})
