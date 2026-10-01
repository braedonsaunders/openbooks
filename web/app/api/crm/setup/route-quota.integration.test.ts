import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { NextRequest } from 'next/server'
import test from 'node:test'

// Quota save validates amount to 4dp but never bounds its magnitude, so a
// pasted 20-digit figure sails through and dies in Postgres as a raw
// numeric(19,4) overflow (HTTP 500) instead of failing closed with the named
// 422 the junk-amount path returns.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmQuotaMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../lib/feature-gates'
      || (specifier === '@/lib/feature-gates' && context.parentURL?.includes('/web/lib/api/route.ts'))) return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmQuotaMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    return next(specifier, context)
  },
})
const { withBypassContext, db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')

async function fixture() {
  const org = await withBypassContext(() => (createScratchOrg()))
  state.orgId = org.orgId
  state.actorId = (await withBypassContext(() => (seedFlowActors(org.orgId)))).adminId
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId}`))
  await withBypassContext(() => (db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`)))
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
  const rows = (await withOrgContext(state.orgId,()=>db.execute<{ n: number }>(sql`
    select count(*)::int as n from crm_sales_quotas where org_id = ${state.orgId}`))).rows
  return rows[0]!.n
}

test('POST refuses a quota amount wider than numeric(19,4) without writing', async () => {
  const { org } = await fixture()
  try {
    const result = await post(quotaAction('99999999999999999999'))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await quotaCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('retired setup refuses writes and native Sales preserves a column-maximum quota exactly', async () => {
  const { org } = await fixture()
  try {
    const result = await post(quotaAction('999999999999999.9999'))
    assert.equal(result.status, 410, JSON.stringify(result.json))
    assert.match((result.json as {error:string}).error, /Sales/)
    assert.equal(await quotaCount(), 0)
    const {writeSalesCommand} = await import('@openbooks/engine/crm/sales')
    const employee = await withBypassContext(async () => {
      const p = (await db.execute<{id:string}>(sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${state.orgId},'employee','Quota representative',${org.subsidiaryId}) returning id`)).rows[0]!.id
      await db.execute(sql`insert into employee_roles(org_id,party_id,is_sales_rep,sales_rep_since) values(${state.orgId},${p},true,'2020-01-01')`)
      return p
    })
    await withOrgContext(state.orgId, () => writeSalesCommand({orgId:state.orgId, actorId:state.actorId, allowedSubsidiaryIds:null}, {action:'quota', name:'Maximum target', subsidiaryId:org.subsidiaryId, employeeId:employee, salesTeamId:null, parentQuotaId:null, supersedesId:null, reason:'', periodStart:'2026-07-01',periodEnd:'2026-07-31',currency:'CAD',amount:'999999999999999.9999',metric:'closed_won'}))
    const rows = (await withOrgContext(state.orgId,()=>db.execute<{ amount: string }>(sql`
      select amount::text as amount from crm_sales_quotas where org_id = ${state.orgId}`))).rows
    assert.equal(rows[0]!.amount, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
