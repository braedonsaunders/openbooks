import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Account PATCH validates employeeCount as a non-negative integer and
// annualRevenue to 4dp but bounds neither, so an out-of-int32 headcount or a
// pasted 20-digit revenue sails through and dies in Postgres as a raw storage
// failure (HTTP 500 — the verb has no catch) instead of failing closed with a
// named 422. annual_revenue is numeric(19,4); employee_count is integer.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmAccountMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__crmAccountMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmAccountMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  state.actorId = randomUUID()
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`))
  const partyId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, is_active)
    values (${org.orgId}, 'company', 'Magnitude Account', true)
    returning id`))).rows[0]!.id
  await withBypassContext(() => db.execute(sql`
    insert into crm_account_profiles (org_id, party_id, lifecycle_stage, annual_revenue, employee_count)
    values (${org.orgId}, ${partyId}, 'lead', '100.0000', 10)`))
  return { org, partyId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://crm.test/api/crm/accounts/${id}`, {
        method: 'PATCH',
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

async function profile(partyId: string) {
  const rows = (await withOrgContext(state.orgId, () => db.execute<{ annual_revenue: string | null; employee_count: number | null }>(sql`
    select annual_revenue::text as annual_revenue, employee_count
      from crm_account_profiles where party_id = ${partyId}`))).rows
  return rows[0]!
}

test('PATCH refuses an employee count outside int32 without writing', { skip: !DB }, async () => {
  const { org, partyId } = await fixture()
  try {
    const result = await patch(partyId, { employeeCount: '99999999999999999999' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await profile(partyId), { annual_revenue: '100.0000', employee_count: 10 })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses an annual revenue wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, partyId } = await fixture()
  try {
    const result = await patch(partyId, { annualRevenue: '99999999999999999999' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual(await profile(partyId), { annual_revenue: '100.0000', employee_count: 10 })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves column-maximum figures with identical read-back', { skip: !DB }, async () => {
  const { org, partyId } = await fixture()
  try {
    const result = await patch(partyId, { annualRevenue: '999999999999999.9999', employeeCount: 2147483647 })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.deepEqual(await profile(partyId), { annual_revenue: '999999999999999.9999', employee_count: 2147483647 })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
