import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// routeCrmAccount locked its account row with a bare FOR UPDATE over a LEFT
// JOIN LATERAL address lookup, which Postgres refuses outright ("FOR UPDATE
// cannot be applied to the nullable side of an outer join"), so every
// PATCH { route: true } died with a 500. These tests go through the HTTP
// route: one with no address or territory at all (the nullable-side shape),
// one proving address attribution actually assigns the matching territory.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmAccountRoutingState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__crmAccountRoutingState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmAccountRoutingState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, createScratchUser } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture(withAddress: boolean) {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  const ownerId = await withBypassContext(() => createScratchUser(org.orgId, 'Territory Owner', 'owner'))
  state.actorId = ownerId
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
    await withBypassContext(() => db.execute(sql`
      insert into crm_sales_territories (org_id, key, name, priority, match_mode, rules, default_owner_user_id, is_active)
      values (${org.orgId}, 'us-west', 'US West', 10, 'all',
              '[{"field": "country", "operator": "equals", "value": "US"}]'::jsonb,
              ${ownerId}, true)`))
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

test('PATCH { route: true } succeeds when the account has no address or territory', { skip: !DB }, async () => {
  const { org, partyId } = await fixture(false)
  try {
    const result = await patch(partyId, { route: true })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH { route: true } assigns the matching territory, owner, and assignment event', { skip: !DB }, async () => {
  const { org, partyId, profileId, ownerId } = await fixture(true)
  try {
    const result = await patch(partyId, { route: true })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    const profile = (await withBypassContext(() => db.execute<{ territory_id: string | null; owner_user_id: string | null }>(sql`
      select territory_id, owner_user_id from crm_account_profiles where id = ${profileId}`))).rows[0]!
    assert.ok(profile.territory_id, 'expected the matching territory to be assigned')
    assert.equal(profile.owner_user_id, ownerId)
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
