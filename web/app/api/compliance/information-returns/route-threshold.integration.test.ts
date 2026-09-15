import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Information-return POST passes threshold to the filing insert raw — never
// validated at the route or in ensureFiling — so junk text or a pasted
// 20-digit figure dies in Postgres as a raw storage failure (HTTP 500; the
// verb only maps InformationReturnError to 422) instead of failing closed
// with a named 4xx and nothing written. threshold is numeric(19,4).
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __infoReturnThresholdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}')
    if (specifier === '@/lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__infoReturnThresholdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function guardSubsidiaryScope() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"subcontractorCompliance": true}'::jsonb)
     where id = ${org.orgId}`)
  return { org }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new Request('http://compliance.test/api/compliance/information-returns', {
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

async function filingCount(): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from information_return_filings where org_id = ${state.orgId}`)).rows
  return rows[0]!.n
}

test('POST refuses a junk threshold without writing a filing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxYear: 2024, formType: '1099-NEC', threshold: 'abc' })
    assert.ok(result.status === 400 || result.status === 422, `expected 4xx, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await filingCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST refuses a threshold wider than numeric(19,4) without writing a filing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxYear: 2024, formType: '1099-NEC', threshold: '99999999999999999999' })
    assert.ok(result.status === 400 || result.status === 422, `expected 4xx, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await filingCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still files with a column-maximum threshold and identical read-back', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ taxYear: 2024, formType: '1099-NEC', threshold: '999999999999999.9999' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await db.execute<{ threshold: string }>(sql`
      select threshold::text as threshold from information_return_filings where org_id = ${state.orgId}`)).rows
    assert.equal(rows[0]!.threshold, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
