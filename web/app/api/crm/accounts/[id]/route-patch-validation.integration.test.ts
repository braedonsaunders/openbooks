import assert from 'node:assert/strict'
import { stubModules, withAuthzTestSurface } from '@/testing/stub-modules'
import test from 'node:test'

// PATCH used to persist `is_active = (body.isActive === true)` whenever the
// field was present, so {"isActive": "true"}, 1 and null all silently
// DEACTIVATED the account while returning success — and the audit captured
// the requested body, not the resulting state. Every PATCH field is now
// type-checked (422 naming the field) and the audit records the actual
// before/after row.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __crmAccountPatchValidationState: state })
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface(`
      const state = globalThis.__crmAccountPatchValidationState;
      const session = () => ({ user: { orgId: state.orgId, id: state.actorId }, permissions: [], allowedSubsidiaryIds: null });
      export async function getAuthz() { return session(); }
      export async function guardPermission() { return session(); }
    `),
  },
  features: {
    source: `
      const state = globalThis.__crmAccountPatchValidationState;
      const session = () => ({ user: { orgId: state.orgId, id: state.actorId }, permissions: [], allowedSubsidiaryIds: null });
      export async function isFeatureEnabled() { return true; }
      export async function guardFeaturePermission() { return session(); }
    `,
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { randomUUID } = await import('node:crypto')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')

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
    values (${org.orgId}, 'company', 'Validation Account', true)
    returning id`))).rows[0]!.id
  const profileId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into crm_account_profiles (org_id, party_id, lifecycle_stage, industry, qualification_score, is_active)
    values (${org.orgId}, ${partyId}, 'lead', 'Software', 10, true)
    returning id`))).rows[0]!.id
  return { org, partyId, profileId }
}

type PatchResult = { status: number; json: { error?: string; issues?: { path: string }[] } | null }

async function patch(id: string, body: unknown): Promise<PatchResult> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://crm.test/api/crm/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: (await response.json().catch(() => null)) as PatchResult['json'] }
  } catch (error) {
    return { status: 500, json: { error: error instanceof Error ? error.message : String(error) } }
  }
}

async function profileState(profileId: string) {
  return (await withBypassContext(() => db.execute<{ is_active: boolean; industry: string | null; qualification_score: number | null }>(sql`
    select is_active, industry, qualification_score from crm_account_profiles where id = ${profileId}`))).rows[0]!
}

// The revision token PATCH mandates (F3-97): every pre-existing call below
// targets field validation, so each carries a fresh token to reach it.
async function revisionFor(partyId: string): Promise<string> {
  return (await withBypassContext(() => db.execute<{ revision: string }>(sql`
    select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision
      from crm_account_profiles where party_id = ${partyId}`))).rows[0]!.revision
}

for (const malformed of ['true', 1, null]) {
  test(`PATCH refuses isActive=${JSON.stringify(malformed)} without deactivating`, async () => {
    const { org, partyId, profileId } = await fixture()
    try {
      const result = await patch(partyId, { isActive: malformed, expectedUpdatedAt: await revisionFor(partyId) })
      assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
      assert.ok(result.json?.issues?.some((issue) => issue.path === 'isActive'))
      assert.deepEqual(await profileState(profileId), { is_active: true, industry: 'Software', qualification_score: 10 })
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
}

test('PATCH still deactivates on a real boolean false', async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { isActive: false, expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal((await profileState(profileId)).is_active, false)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a boolean qualification score without writing', async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { qualificationScore: true, expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.ok(result.json?.issues?.some((issue) => issue.path === 'qualificationScore'))
    assert.equal((await profileState(profileId)).qualification_score, 10)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a non-string industry without clearing it', async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { industry: 123, expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.ok(result.json?.issues?.some((issue) => issue.path === 'industry'))
    assert.equal((await profileState(profileId)).industry, 'Software')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH audits the actual before/after row, not the request', async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    const result = await patch(partyId, { isActive: false, industry: 'Hardware', expectedUpdatedAt: await revisionFor(partyId) })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const audit = (await withBypassContext(() => db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'crm_account_profiles' and row_id = ${profileId}
       order by at desc, id desc limit 1`))).rows[0]!.changes as {
      before: { is_active: boolean; industry: string };
      after: { is_active: boolean; industry: string };
      requested?: unknown;
    }
    assert.equal(audit.requested, undefined)
    assert.equal(audit.before.is_active, true)
    assert.equal(audit.before.industry, 'Software')
    assert.equal(audit.after.is_active, false)
    assert.equal(audit.after.industry, 'Hardware')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH stores custom values only after validating them against the account definitions', async () => {
  const { org, partyId, profileId } = await fixture()
  try {
    await withBypassContext(() => db.execute(sql`
      insert into custom_field_defs (org_id, target_table, key, label, field_type, config)
      values (${org.orgId}, 'crm_account_profiles', 'tier', 'Tier', 'select', '{"options":["gold","silver"]}'::jsonb)`))
    const stored = async () => (await withBypassContext(() => db.execute<{ custom: unknown }>(sql`
      select custom from crm_account_profiles where id = ${profileId}`))).rows[0]!.custom
    for (const [custom, status, refusal] of [
      [{ tier: 'gold' }, 200, null],
      [{ tier: 'bronze' }, 422, /Tier: invalid option/],
      [{ region: 'west' }, 422, /unknown custom field: region/],
    ] as const) {
      const result = await patch(partyId, { custom, expectedUpdatedAt: await revisionFor(partyId) })
      assert.equal(result.status, status, JSON.stringify(result.json))
      if (refusal) assert.match(result.json?.error ?? '', refusal)
      assert.deepEqual(await stored(), { tier: 'gold' })
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
