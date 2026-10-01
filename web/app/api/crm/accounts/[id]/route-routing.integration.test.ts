import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// routeCrmAccount locked its account row with a bare FOR UPDATE over a LEFT
// JOIN LATERAL address lookup, which Postgres refuses outright ("FOR UPDATE
// cannot be applied to the nullable side of an outer join"), so every
// PATCH { route: true } died with a 500. These tests go through the HTTP
// route: one with no address or territory at all (the nullable-side shape),
// one proving address attribution actually assigns the matching territory.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmAccountRoutingState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__crmAccountRoutingState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates' || specifier === '@/lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmAccountRoutingState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    return next(specifier, context)
  },
})
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import { createScratchOrg, dropScratchOrg, createScratchUser } from '@openbooks/engine/src/testing/fixtures.ts'
const { PATCH } = await import('./route.ts')

async function fixture(withAddress: boolean) {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  const ownerId = await withBypassContext(() => createScratchUser(org.orgId, 'Territory Owner', 'owner'))
  state.actorId = ownerId
  await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId}`))
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`))
  const partyId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, is_active)
    values (${org.orgId}, 'company', 'Routable Account', true)
    returning id`))).rows[0]!.id
  const profileId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into crm_account_profiles (org_id, party_id, lifecycle_stage, is_active)
    values (${org.orgId}, ${partyId}, 'lead', true)
    returning id`))).rows[0]!.id
  if (withAddress) {
    await withBypassContext(() => db.execute(sql`
      insert into addresses (org_id, party_id, country, region, is_default_billing)
      values (${org.orgId}, ${partyId}, 'US', 'CA', true)`))
    const employee = await withBypassContext(async () => {
      await db.execute(sql`update parties set subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${partyId}`)
      const p=(await db.execute<{id:string}>(sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${org.orgId},'employee','Territory representative',${org.subsidiaryId}) returning id`)).rows[0]!.id
      await db.execute(sql`insert into employee_roles(org_id,party_id,is_sales_rep,sales_rep_since) values(${org.orgId},${p},true,'2020-01-01')`)
      return p
    })
    const {writeSalesCommand,previewTerritory} = await import('@openbooks/engine/crm/sales')
    const input={action:'territory' as const, name:'US West', subsidiaryId:org.subsidiaryId, managerEmployeeId:null, defaultEmployeeId:employee, salesTeamId:null,description:'',priority:10,matchMode:'all' as const,rules:[{field:'country' as const,operator:'equals' as const,value:'US'}], geography:{version:1 as const,includes:[],excludes:[],polygons:[]},effectiveFrom:'2020-01-01',lifecycle:'active' as const}
    const scope={orgId:org.orgId,actorId:ownerId,allowedSubsidiaryIds:null}
    await withOrgContext(org.orgId,async()=>{
      const preview=await db.transaction(tx=>previewTerritory(tx,scope,input))
      await writeSalesCommand(scope,{...input,previewRevision:preview.revision})
    })

  }
  return { org, partyId, profileId, ownerId }
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


// The revision token PATCH mandates (F3-97): every pre-existing call below
// targets other behavior, so each carries a fresh token to reach it.
async function revisionFor(partyId: string): Promise<string> {
  return (await withBypassContext(() => db.execute<{ revision: string }>(sql`
    select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision
      from crm_account_profiles where party_id = ${partyId}`))).rows[0]!.revision
}

test('PATCH { route: true } succeeds when the account has no address or territory', async () => {
  const { org, partyId } = await fixture(false)
  try {
    const result = await patch(partyId, { route: true, expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH { route: true } assigns the matching territory, owner, and assignment event', async () => {
  const { org, partyId, profileId } = await fixture(true)
  try {
    const result = await patch(partyId, { route: true, expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    const profile = (await withBypassContext(() => db.execute<{ territory_id: string | null; sales_rep_id: string | null }>(sql`
      select territory_id, sales_rep_id from crm_account_profiles where id = ${profileId}`))).rows[0]!
    assert.ok(profile.territory_id, 'expected the matching territory to be assigned')
    assert.ok(profile.sales_rep_id)
    const native=(await withBypassContext(()=>db.execute<{party_id:string}>(sql`select party_id from employee_roles where org_id=${org.orgId} and party_id=${profile.sales_rep_id}`))).rows
    assert.equal(native.length,1, 'the assigned representative is a native employee')
    const events = (await withBypassContext(() => db.execute<{ to_territory_id: string; source: string }>(sql`
      select to_territory_id, source from crm_account_assignment_events
       where org_id = ${org.orgId} and account_profile_id = ${profileId}`))).rows
    assert.equal(events.length, 1)
    assert.equal(events[0]!.to_territory_id, profile.territory_id)
    assert.equal(events[0]!.source, 'routing')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
