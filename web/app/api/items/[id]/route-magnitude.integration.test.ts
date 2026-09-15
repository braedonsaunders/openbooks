import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Item PATCH validates defaultRate/defaultCost/standaloneSellingPrice to 4dp
// but never bounds their magnitude, so a pasted 20-digit figure sails through
// validation and dies in Postgres as a raw numeric(19,4) overflow (HTTP 500)
// instead of failing closed with a named 422.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __itemPatchMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__itemPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"revenueRecognition": true}'::jsonb)
     where id = ${org.orgId}`)
  const itemId = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active, default_rate, default_cost)
    values (${org.orgId}, 'service', 'Magnitude Item', true, '100.0000', '40.0000')
    returning id`)).rows[0]!.id
  return { org, itemId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://items.test/api/items/${id}`, {
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

async function rates(itemId: string) {
  const rows = (await db.execute<{ default_rate: string | null; default_cost: string | null }>(sql`
    select default_rate::text as default_rate, default_cost::text as default_cost
      from items where id = ${itemId}`)).rows
  return rows[0]!
}

for (const field of ['defaultRate', 'defaultCost', 'standaloneSellingPrice'] as const) {
  test(`PATCH refuses a ${field} wider than numeric(19,4) without writing`, { skip: !DB }, async () => {
    const { org, itemId } = await fixture()
    try {
      const result = await patch(itemId, { [field]: '99999999999999999999' })
      assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
      assert.deepEqual(await rates(itemId), { default_rate: '100.0000', default_cost: '40.0000' })
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
}

test('PATCH still saves a column-maximum default rate with identical read-back', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await patch(itemId, { defaultRate: '999999999999999.9999' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal((await rates(itemId)).default_rate, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a foreign reference custom value instead of storing it', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  const foreign = await createScratchOrg()
  try {
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'items', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${state.actorId}, ${state.actorId})
    `)
    const refused = await patch(itemId, { custom: { ref_party: foreign.vendorId } })
    assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.json)}`)
    const stored = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from items where id = ${itemId}`)).rows[0]?.custom
    assert.equal((stored as Record<string, unknown> | undefined)?.ref_party, undefined, 'refused references store nothing')
    const saved = await patch(itemId, { custom: { ref_party: org.vendorId } })
    assert.equal(saved.status, 200, `own-org reference must stay green: ${JSON.stringify(saved.json)}`)
  } finally {
    await dropScratchOrg(foreign.orgId)
    await dropScratchOrg(org.orgId)
  }
})
