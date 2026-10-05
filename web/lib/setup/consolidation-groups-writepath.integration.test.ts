import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * Consolidation groups bill every period through their payer and billing
 * entity, so a group pointing outside the organization must die on the
 * write path — never survive to refuse every run at consolidation time.
 */
async function seedOrg(): Promise<{ orgId: string; actorId: string; payerId: string }> {
  const org = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`
    update orgs set settings = settings || '{"features":{"consolidatedBilling":true}}'::jsonb
     where id = ${org.orgId}`))
  const payerId = randomUUID()
  await withBypass(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${payerId}, ${org.orgId}, 'customer', 'Parent Co', ${org.subsidiaryId}, true, '{}'::jsonb)`))
  return { orgId: org.orgId, actorId, payerId }
}

function actor(orgId: string, actorId: string) {
  return { orgId, id: actorId, permissions: ['documents.manage'] }
}

async function groupCount(orgId: string): Promise<number> {
  const r = await withBypass(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from consolidation_groups where org_id = ${orgId}`))
  return r.rows[0]!.n
}

test('a group naming a payer outside the organization is refused with no row', { skip: !DB }, async () => {
  const { orgId, actorId } = await seedOrg()
  try {
    const before = await groupCount(orgId)
    const result = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      code: 'GRP-X', name: 'Elsewhere', payerPartyId: randomUUID(),
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(result.status, 400)
    assert.equal((result.body as { code?: unknown }).code, 'invalid')
    assert.match(String((result.body as { error?: unknown }).error ?? ''), /payer from this organization/)
    assert.equal(await groupCount(orgId), before, 'the refused write persists nothing')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('a valid group saves through generic setup CRUD and its code stays unique', { skip: !DB }, async () => {
  const { orgId, actorId, payerId } = await seedOrg()
  try {
    // Single-entity orgs consolidate through the payer's own entity: no
    // billing subsidiary is named and none is needed.
    const created = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      code: 'GRP-1', name: 'Parent monthly', payerPartyId: payerId,
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(created.status, 200, `valid group refused: ${JSON.stringify(created.body)}`)
    const duplicate = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      code: 'GRP-1', name: 'Parent duplicate', payerPartyId: payerId,
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(duplicate.status, 409)
    assert.equal(await groupCount(orgId), 1, 'the duplicate code stores no second group')
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})

test('a billing entity outside the organization is refused, an active one saves', { skip: !DB }, async () => {
  const { orgId, actorId, payerId } = await seedOrg()
  try {
    const root = (await withBypass(() => db.execute<{ subsidiaryId: string }>(sql`
      select s.id as "subsidiaryId" from subsidiaries s
       where s.org_id = ${orgId} and s.is_active order by s.created_at limit 1`))).rows[0]!.subsidiaryId
    const branchId = randomUUID()
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branchId}, ${orgId}, ${root}, 'Branch', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`))
    const foreign = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      code: 'GRP-X', name: 'Foreign entity', payerPartyId: payerId,
      billingSubsidiaryId: randomUUID(),
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(foreign.status, 400)
    assert.match(String((foreign.body as { error?: unknown }).error ?? ''), /billing entity from this organization/)
    const crossEntity = await withBypass(() => createSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      code: 'GRP-2', name: 'Branch billing', payerPartyId: payerId,
      billingSubsidiaryId: branchId,
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(crossEntity.status, 200, `cross-entity group refused: ${JSON.stringify(crossEntity.body)}`)
    const groupId = String((crossEntity.body as { id?: unknown }).id)
    const cleared = await withBypass(() => updateSetupRecord(actor(orgId, actorId), 'consolidation-groups', {
      id: groupId, code: 'GRP-2', name: 'Branch billing', payerPartyId: payerId,
      billingSubsidiaryId: null,
      cadence: 'monthly', cutoffDay: 1, grouping: 'by_child', isActive: true,
    }))
    assert.equal(cleared.status, 200, `clearing the billing entity refused: ${JSON.stringify(cleared.body)}`)
  } finally {
    await withBypass(() => dropScratchOrg(orgId))
  }
})
