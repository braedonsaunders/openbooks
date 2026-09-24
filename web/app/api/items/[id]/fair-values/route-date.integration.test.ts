import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Fair-value POST validates effectiveFrom/effectiveTo with a format-only
// regex, so a shape-valid non-day such as February 30 sails through
// validation and dies in Postgres as a raw DATE failure (HTTP 500) instead
// of failing closed with the same 400 the junk-input path returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __fairValueDateState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__fairValueDateState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
      export function guardUnrestrictedScope() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const itemId = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Fair Value Item', true)
    returning id`)).rows[0]!.id
  return { org, itemId }
}

async function post(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new Request(`http://fv.test/api/items/${id}/fair-values`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('POST refuses an impossible effective date without writing', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await post(itemId, { currency: 'CAD', unitPrice: '10', effectiveFrom: '2024-02-30' })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    const rows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from fair_value_prices where item_id = ${itemId}`)).rows
    assert.equal(rows[0]!.n, 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves a real effective date', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await post(itemId, { currency: 'CAD', unitPrice: '10', effectiveFrom: '2024-02-29' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
