import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// H-ASSET-TAXPOLICY: POST /api/assets/tax-depreciation-packs and PATCH
// /api/assets/tax-category-assignments install or modify the org-wide tax
// regime and category config that governs depreciation in every entity, but
// gated only admin.setup.manage. A subsidiary-scoped caller now gets the
// named org-wide-policy refusal before any read or write; an unrestricted
// caller reaches the installer exactly as before.
interface AssetTaxState {
  restricted: boolean
  installCalls: number
  dbCalls: number
  openPoolClass: string | null
  assignmentWrites: number
}

const stateKey = Symbol.for('openbooks.asset-tax-scope-test')
const assetTaxState: AssetTaxState = { restricted: false, installCalls: 0, dbCalls: 0, openPoolClass: null, assignmentWrites: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = assetTaxState

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.asset-tax-scope-test')]
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
      // Org-wide tax-policy gate: only an explicit unrestricted scope
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
      const state = globalThis[Symbol.for('openbooks.asset-tax-scope-test')]
      export const db = {
        async execute() {
          state.dbCalls += 1
          return { rows: [{ class_attribute: 'ca_cca_class' }] }
        },
        async transaction(work) {
          let calls = 0
          return work({ execute: async () => {
            calls += 1
            if (calls === 1) return { rows: [{ subsidiary_id: 'sub-a' }, { subsidiary_id: 'sub-b' }] }
            if (calls === 5) return { rows: [{ tax_attributes: { ca_cca_class: '8' } }] }
            if (calls === 6) return { rows: state.openPoolClass ? [{ class_code: state.openPoolClass }] : [] }
            if (calls === 7) {
              state.assignmentWrites += 1
              return { rows: [{ tax_attributes: {} }] }
            }
            return { rows: [] }
          } })
        },
      }
    `,
  ],
  [
    'mock:packs',
    `
      const state = globalThis[Symbol.for('openbooks.asset-tax-scope-test')]
      export function taxDepreciationPacks() { return [] }
      export async function installTaxDepreciationPack() {
        state.installCalls += 1
        return { installed: true }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/tax-returns/depreciation-packs.ts') return { url: 'mock:packs', shortCircuit: true }
    if (specifier.endsWith('/lib/feature-gates')) return { url: 'mock:feature-gates', shortCircuit: true }
    if (specifier.endsWith('/lib/authz')) return { url: 'mock:authz', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  },
})

const packsUrl = '../tax-depreciation-packs/route.ts?asset-tax-scope-test'
const { POST: installPack } = (await import(packsUrl)) as typeof import('../tax-depreciation-packs/route.ts')
const assignmentsUrl = './route.ts?asset-tax-scope-test'
const { PATCH: assignCategory } = (await import(assignmentsUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(restricted: boolean): void {
  assetTaxState.restricted = restricted
  assetTaxState.installCalls = 0
  assetTaxState.dbCalls = 0
  assetTaxState.openPoolClass = null
  assetTaxState.assignmentWrites = 0
}

test('pack install by a scoped caller is refused before the installer runs', async () => {
  reset(true)
  const response = await installPack(
    new Request('http://openbooks.test/api/assets/tax-depreciation-packs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CA_CCA' }),
    }),
  )
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(assetTaxState.installCalls, 0)
})

test('pack install by an unrestricted caller reaches the installer', async () => {
  reset(false)
  const response = await installPack(
    new Request('http://openbooks.test/api/assets/tax-depreciation-packs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CA_CCA' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(assetTaxState.installCalls, 1)
})

test('category assignment by a scoped caller is refused before any read', async () => {
  reset(true)
  const response = await assignCategory(
    new Request('http://openbooks.test/api/assets/tax-category-assignments', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        categoryId: '00000000-0000-4000-8000-00000000c101',
        regime: 'CA_CCA',
      }),
    }),
  )
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(assetTaxState.dbCalls, 0)
})

test('removing a category class with a nonzero pool is refused without changing or auditing the assignment', async () => {
  reset(false)
  assetTaxState.openPoolClass = '8'
  const response = await assignCategory(
    new Request('http://openbooks.test/api/tax-category-assignments', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        categoryId: '00000000-0000-4000-8000-00000000c101',
        regime: 'ca_cca',
      }),
    }),
  )
  assert.equal(response.status, 422)
  const payload = await response.json() as { error: string }
  assert.match(payload.error, /cannot remove tax class "8" while its pool has a nonzero balance/)
  assert.equal(assetTaxState.assignmentWrites, 0)
})
