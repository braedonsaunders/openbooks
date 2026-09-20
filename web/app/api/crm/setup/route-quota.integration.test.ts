import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { NextRequest } from 'next/server'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Quota save validates amount to 4dp but never bounds its magnitude, so a
// pasted 20-digit figure sails through and dies in Postgres as a raw
// numeric(19,4) overflow (HTTP 500) instead of failing closed with the named
// 422 the junk-amount path returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmQuotaMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmQuotaMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`)
  return { org }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new NextRequest('http://crm.test/api/crm/setup', {
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

function quotaAction(amount: unknown) {
  return {
    action: 'save-quota', ownerUserId: state.actorId,
    periodStart: '2026-07-01', periodEnd: '2026-07-31', amount,
  }
}

async function quotaCount(): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from crm_sales_quotas where org_id = ${state.orgId}`)).rows
  return rows[0]!.n
}

test('POST refuses a quota amount wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post(quotaAction('99999999999999999999'))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await quotaCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves a column-maximum quota amount with identical read-back', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post(quotaAction('999999999999999.9999'))
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await db.execute<{ amount: string }>(sql`
      select amount::text as amount from crm_sales_quotas where org_id = ${state.orgId}`)).rows
    assert.equal(rows[0]!.amount, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
