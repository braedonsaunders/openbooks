import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// H-TAXSETUP: POST /api/tax/provision and POST /api/tax/returns write
// org-wide statutory packs, forms, and libraries used by every entity, but
// gated only admin.setup.manage — a subsidiary-restricted setup manager
// could install or reset them for the whole org. Both now require
// unrestricted scope (the shared helper), refused by name before any
// planning or provisioning runs.
interface TaxSetupState {
  restricted: boolean
  provisionCalls: number
  installCalls: number
}

const stateKey = Symbol.for('openbooks.tax-setup-scope-test')
const taxState: TaxSetupState = { restricted: false, provisionCalls: 0, installCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = taxState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.restricted ? new Set(['sub-a']) : null,
        }
      }
      // Org-wide configuration gate: only an explicit unrestricted scope
      // passes — the canonical assertUnrestrictedScope rule.
      export function guardUnrestrictedScope(authz) {
        if (authz.allowedSubsidiaryIds === null) return null
        return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
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
  [
    'mock:provisioning',
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export function isTaxProvisionSelection() { return true }
      export async function packInstallationStatuses() { return [] }
      export async function provisionTaxPacks() {
        state.provisionCalls += 1
        return { installed: [] }
      }
    `,
  ],
  [
    'mock:seed-forms',
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export const TAX_RETURN_PACKS = [{ code: 'X' }]
      export async function installTaxReturnPacks() {
        state.installCalls += 1
        return []
      }
    `,
  ],
  [
    'mock:db',
    `
      export const db = {
        async execute() { return { rows: [] } },
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    if (specifier === '@/lib/api/json') return { url: 'mock:json', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/tax/pack-provisioning.ts') {
      return { url: 'mock:provisioning', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/tax/seed-tax-forms.ts') {
      return { url: 'mock:seed-forms', shortCircuit: true }
    }
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

const provisionUrl = '../provision/route.ts?tax-setup-scope-test'
const { POST: provisionPost } = (await import(provisionUrl)) as typeof import('../provision/route.ts')
const returnsUrl = './route.ts?tax-setup-scope-test'
const { POST: returnsPost } = (await import(returnsUrl)) as typeof import('./route.ts')
hooks.deregister()

function jsonRequest(body: unknown): Request {
  return new Request('http://openbooks.test/api/tax', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function reset(restricted: boolean): void {
  taxState.restricted = restricted
  taxState.provisionCalls = 0
  taxState.installCalls = 0
}

test('provision by a restricted setup manager is refused before provisioning', async () => {
  reset(true)
  const response = await provisionPost(jsonRequest({ packs: ['CA_GST_HST'] }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(taxState.provisionCalls, 0)
})

test('provision by an unrestricted setup manager proceeds', async () => {
  reset(false)
  const response = await provisionPost(jsonRequest({ packs: ['CA_GST_HST'] }))
  assert.equal(response.status, 200)
  assert.equal(taxState.provisionCalls, 1)
})

test('return-pack install by a restricted setup manager is refused before planning writes', async () => {
  reset(true)
  const response = await returnsPost(jsonRequest({ mode: 'install', packs: ['X'] }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.equal(taxState.installCalls, 0)
})

test('return-pack install by an unrestricted setup manager proceeds', async () => {
  reset(false)
  const response = await returnsPost(jsonRequest({ mode: 'install', packs: ['X'] }))
  assert.equal(response.status, 200)
  assert.equal(taxState.installCalls, 1)
})
