import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F3-97: the relationship PATCH carried no concurrency token while the main
// party and bank-account saves are versioned, so two tabs holding the same
// relationship silently replaced each other. PATCH now mandates the revision
// token the GET surfaces as profile.updated_at: a missing, malformed, or
// stale token 409s naming the reload remedy, and every write rotates the
// token so a consumed one never works twice.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmAccountRevisionState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return "" }')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__crmAccountRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__crmAccountRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH } = await import('./route.ts')
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
    values (${org.orgId}, 'company', 'Revision Account', true)
    returning id`))).rows[0]!.id
  const profileId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into crm_account_profiles (org_id, party_id, lifecycle_stage, industry, is_active)
    values (${org.orgId}, ${partyId}, 'lead', 'Software', true)
    returning id`))).rows[0]!.id
  return { org, partyId, profileId }
}

// The token exactly as a drawer tab would hold it: read off the GET wire
// form, never reconstructed from the timestamp format.
async function tokenFor(id: string): Promise<string> {
  const response = await withOrgContext(state.orgId, () => GET(
    new Request(`http://crm.test/api/crm/accounts/${id}`),
    { params: Promise.resolve({ id }) },
  ))
  assert.equal(response.status, 200, `GET must serve the fixture: ${await response.clone().text()}`)
  const json = (await response.json()) as { account: { profile: { updated_at: unknown } } | null }
  assert.ok(json.account, 'the fixture must track a relationship')
  assert.equal(typeof json.account.profile.updated_at, 'string', 'the read must surface a revision token')
  return json.account.profile.updated_at as string
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: { error?: string } | null }> {
  const response = await withOrgContext(state.orgId, () => PATCH(
    new Request(`http://crm.test/api/crm/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ))
  return { status: response.status, json: (await response.json().catch(() => null)) as { error?: string } | null }
}

async function industryOf(profileId: string): Promise<string | null> {
  return (await withBypassContext(() => db.execute<{ industry: string | null }>(sql`
    select industry from crm_account_profiles where id = ${profileId}`))).rows[0]!.industry
}

test('PATCH without a revision token is refused before any write', { skip: !DB }, async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { industry: 'Hardware' })
    assert.equal(result.status, 409, `expected 409, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(result.json?.error ?? '', /changed after you opened it/)
    assert.match(result.json?.error ?? '', /reload and reapply/)
    assert.equal(await industryOf(profileId), 'Software')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH with a malformed token is refused before any write', { skip: !DB }, async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { industry: 'Hardware', expectedUpdatedAt: 'not-a-token' })
    assert.equal(result.status, 409, `expected 409, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await industryOf(profileId), 'Software')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a stale token loses to the concurrent write, which stays intact', { skip: !DB }, async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const firstRead = await tokenFor(partyId)
    const winner = await patch(partyId, { industry: 'Hardware', expectedUpdatedAt: firstRead })
    assert.equal(winner.status, 200, JSON.stringify(winner.json))
    const loser = await patch(partyId, { industry: 'Wholesale', expectedUpdatedAt: firstRead })
    assert.equal(loser.status, 409, `expected 409, got ${loser.status}: ${JSON.stringify(loser.json)}`)
    assert.match(loser.json?.error ?? '', /reload and reapply/)
    assert.equal(await industryOf(profileId), 'Hardware')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a consumed token never works twice', { skip: !DB }, async () => {
  const { org, partyId } = await fixture()
  try {
    const first = await tokenFor(partyId)
    const saved = await patch(partyId, { industry: 'Hardware', expectedUpdatedAt: first })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    const replay = await patch(partyId, { industry: 'Wholesale', expectedUpdatedAt: first })
    assert.equal(replay.status, 409, `expected 409, got ${replay.status}: ${JSON.stringify(replay.json)}`)
    const rotated = await tokenFor(partyId)
    assert.notEqual(rotated, first, 'every write must rotate the token')
    const fresh = await patch(partyId, { industry: 'Wholesale', expectedUpdatedAt: rotated })
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
