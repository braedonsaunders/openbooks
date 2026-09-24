import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// H-ITEMCATALOG: POST /api/items/[id]/rates writes org-wide project billing
// rates under items.manage. A subsidiary-scoped caller now gets the named
// org-wide-policy refusal before the item lookup, the feature checks, or any
// write; an unrestricted caller proceeds past the guard exactly as before.
interface RatesState {
  restricted: boolean
  dbCalls: number
}

const stateKey = Symbol.for('openbooks.item-rates-scope-test')
const ratesState: RatesState = { restricted: false, dbCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = ratesState

const ITEM_ID = '00000000-0000-4000-8000-00000000c101'

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.item-rates-scope-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.restricted ? new Set(['sub-a']) : null,
        }
      }
    `,
  ],
  [
    'mock:authz',
    `
      // Org-wide pricing-policy gate: only an explicit unrestricted scope
      // passes — the canonical assertUnrestrictedScope rule.
      export function guardUnrestrictedScope(authz) {
        if (authz.allowedSubsidiaryIds === null) return null
        return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.item-rates-scope-test')]
      export const db = {
        async execute() {
          state.dbCalls += 1
          return { rows: [] }
        },
        async transaction(work) { return work({ execute: async () => ({ rows: [] }) }) },
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-rates-scope-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function post(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/items/${ITEM_ID}/rates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        effectiveFrom: '2026-01-01',
        baseUnit: 'hour',
        pricingPolicy: 'lowest_cost',
        tiers: [{ unitCode: 'hr', unitName: 'Hour', baseQuantity: '1', costRate: '50', billRate: '125' }],
      }),
    }),
    { params: Promise.resolve({ id: ITEM_ID }) },
  )
}

function reset(restricted: boolean): void {
  ratesState.restricted = restricted
  ratesState.dbCalls = 0
}

test('POST by a scoped caller is refused before the item lookup or any write', async () => {
  reset(true)
  const response = await post()
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(ratesState.dbCalls, 0)
})

test('POST by an unrestricted caller proceeds past the guard', async () => {
  reset(false)
  const response = await post()
  assert.notEqual(response.status, 403)
  assert.ok(ratesState.dbCalls > 0)
})
