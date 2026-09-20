import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Quote POST validates taxableAmount to 4dp but never bounds its magnitude,
// and passes quotedOn to the evidence insert raw — so a pasted 20-digit
// amount or a shape-valid non-day such as February 30 sails through and dies
// in Postgres as a raw numeric/DATE failure (HTTP 500 — the verb only maps
// TaxRateProviderError to 422) instead of failing closed with a named 422.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __taxQuoteMagnitudeState: state })
const engineRoot = new URL('../../../../../engine/', import.meta.url).href
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    // Bare @openbooks/engine/* resolves cross-checkout to main; pin the
    // engine graph to the worktree copy carrying the persistTaxQuote guard.
    if (specifier.startsWith('@openbooks/engine/')) {
      return next(new URL(specifier.slice('@openbooks/engine/'.length), engineRoot).href, context)
    }
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__taxQuoteMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
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
  await db.execute(sql`
    insert into tax_rate_provider_configs (org_id, provider, display_name, is_enabled, settings, created_by, updated_by)
    values (${org.orgId}, 'manual', 'Manual', true, '{"defaultRatePercent": 5}'::jsonb, ${state.actorId}, ${state.actorId})`)
  return { org }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new Request('http://tax.test/api/tax/rate-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function quoteCount(): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from tax_rate_quotes where org_id = ${state.orgId}`)).rows
  return rows[0]!.n
}

test('POST refuses a taxable amount wider than numeric(19,4) without writing evidence', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxableAmount: '99999999999999999999', currency: 'CAD', shipFrom: {}, shipTo: {} })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await quoteCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST refuses an impossible quotedOn without writing evidence', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxableAmount: '100', currency: 'CAD', shipFrom: {}, shipTo: {}, quotedOn: '2024-02-30' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await quoteCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still quotes a column-maximum amount with identical read-back', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxableAmount: '999999999999999.9999', currency: 'CAD', shipFrom: {}, shipTo: {} })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await db.execute<{ taxable_amount: string; tax_amount: string }>(sql`
      select taxable_amount::text as taxable_amount, tax_amount::text as tax_amount
        from tax_rate_quotes where org_id = ${state.orgId}`)).rows
    assert.equal(rows[0]!.taxable_amount, '999999999999999.9999')
    assert.equal(rows[0]!.tax_amount, '50000000000000.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
