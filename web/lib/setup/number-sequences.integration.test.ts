import assert from 'node:assert/strict'
import test from 'node:test'
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { allocateDocumentNumber } = await import('@openbooks/engine/src/records/numbering.ts')
const { createSetupRecord, updateSetupRecord } = await import('./write.ts')
const { setupReadProjection } = await import('./read-shape.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')

async function adminOrg() {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  return { org, asAdmin: { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> } }
}

async function setupRow(orgId: string, id: string) {
  const entity = SETUP_ENTITY_BY_KEY.get('number-sequences')!
  return (await withBypass(() => db.execute<{ next_number: number; allocated_through: number }>(sql`
    select ${setupReadProjection(entity)} from number_sequences where id = ${id} and org_id = ${orgId}`))).rows[0]!
}

test('the configured next number is the next number issued', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const created = await withBypass(() => createSetupRecord(asAdmin, 'number-sequences', {
      documentKind: 'customer_invoice', prefix: 'INV-', nextNumber: 2089, padding: 5,
    }))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = String(created.body.id)
    assert.equal(Number((await setupRow(org.orgId, id)).next_number), 2089)

    assert.equal(await withBypass(() => allocateDocumentNumber(db, org.orgId, 'customer_invoice', 'INV-')), 'INV-02089')
    assert.equal(await withBypass(() => allocateDocumentNumber(db, org.orgId, 'customer_invoice', 'INV-')), 'INV-02090')
    const used = await setupRow(org.orgId, id)
    assert.equal(Number(used.next_number), 2091)
    assert.equal(Number(used.allocated_through), 2090)

    // An issued number can never be configured again; the refusal names the
    // smallest legal choice and the counter is left where it was.
    const backward = await withBypass(() => updateSetupRecord(asAdmin, 'number-sequences', { id, nextNumber: 2090 }))
    assert.equal(backward.status, 400, JSON.stringify(backward.body))
    assert.match(String(backward.body.error), /2091 or higher/)
    assert.equal(Number((await setupRow(org.orgId, id)).next_number), 2091)

    // Skipping ahead issues exactly the configured number.
    const ahead = await withBypass(() => updateSetupRecord(asAdmin, 'number-sequences', { id, nextNumber: 2100 }))
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body))
    assert.equal(await withBypass(() => allocateDocumentNumber(db, org.orgId, 'customer_invoice', 'INV-')), 'INV-02100')
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

test('a new sequence configured to start at 1 issues 1', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const created = await withBypass(() => createSetupRecord(asAdmin, 'number-sequences', {
      documentKind: 'vendor_bill', prefix: 'BILL-', padding: 5,
    }))
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(Number((await setupRow(org.orgId, String(created.body.id))).next_number), 1)
    assert.equal(await withBypass(() => allocateDocumentNumber(db, org.orgId, 'vendor_bill', 'BILL-')), 'BILL-00001')
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
