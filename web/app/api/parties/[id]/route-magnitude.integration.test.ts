import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Party PATCH validates the customer creditLimit to 4dp but never bounds its
// magnitude, so a pasted 20-digit figure sails through validation and dies in
// Postgres as a raw numeric(19,4) overflow (HTTP 500) instead of failing
// closed with a named 422.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __partyPatchMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__partyPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const partyId = (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, is_active)
    values (${org.orgId}, 'company', 'Magnitude Customer', true)
    returning id`)).rows[0]!.id
  const revision = (await db.execute<{ updated_at: string }>(sql`
    select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
      from parties where id = ${partyId}`)).rows[0]!.updated_at
  return { org, partyId, revision }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://parties.test/api/parties/${id}`, {
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

async function roleCount(partyId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from customer_roles where party_id = ${partyId}`)).rows
  return rows[0]!.n
}

test('PATCH refuses a credit limit wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, partyId, revision } = await fixture()
  try {
    const result = await patch(partyId, {
      expectedUpdatedAt: revision,
      roles: { customer: { enabled: true, creditLimit: '99999999999999999999' } },
    })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await roleCount(partyId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves a column-maximum credit limit with identical read-back', { skip: !DB }, async () => {
  const { org, partyId, revision } = await fixture()
  try {
    const result = await patch(partyId, {
      expectedUpdatedAt: revision,
      roles: { customer: { enabled: true, creditLimit: '999999999999999.9999' } },
    })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await db.execute<{ credit_limit: string }>(sql`
      select credit_limit::text as credit_limit from customer_roles where party_id = ${partyId}`)).rows
    assert.equal(rows[0]!.credit_limit, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a foreign reference custom value instead of storing it', { skip: !DB }, async () => {
  const { org, partyId, revision } = await fixture()
  const foreign = await createScratchOrg()
  try {
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'parties', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${state.actorId}, ${state.actorId})
    `)
    const refused = await patch(partyId, { expectedUpdatedAt: revision, custom: { ref_party: foreign.vendorId } })
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.json)}`)
    const stored = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from parties where id = ${partyId}`)).rows[0]?.custom
    assert.equal((stored as Record<string, unknown> | undefined)?.ref_party, undefined, 'refused references store nothing')
    const saved = await patch(partyId, { expectedUpdatedAt: revision, custom: { ref_party: org.vendorId } })
    assert.equal(saved.status, 200, `own-org reference must stay green: ${JSON.stringify(saved.json)}`)
  } finally {
    await dropScratchOrg(foreign.orgId)
    await dropScratchOrg(org.orgId)
  }
})
