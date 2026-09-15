import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Settlement-rates shape-checks its date with a bare regex, so an impossible
// calendar day ('2026-02-30') reaches the ::date cast and escapes as a raw
// Postgres throw (HTTP 500) instead of a 400 field error.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __settlementRatesDateState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__settlementRatesDateState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: ['ap.pay', 'ar.pay'], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

async function get(query: string): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => GET(
      new Request(`http://rates.test/api/payments/settlement-rates${query}`, { method: 'GET' }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('settlement-rates rejects an impossible date instead of throwing', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await get('?side=ap&from=CAD&to=USD&date=2026-02-30')
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('settlement-rates still serves a valid date', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await get('?side=ap&from=CAD&to=USD&date=2026-03-01')
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
