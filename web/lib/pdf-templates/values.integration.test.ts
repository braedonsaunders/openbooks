import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { findSamplePdfRecordId } = await import('./values')

/**
 * The template-editor preview renders the org's "most recent" record. For a
 * subsidiary-restricted designer that sample must be the most recent record
 * INSIDE their scope — never a record of a legal entity hidden from them —
 * and an empty scope yields no real record at all.
 */
test('findSamplePdfRecordId honours the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const hidden = randomUUID()
    await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
      values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden', 'CAD', 'CA')`)

    const visibleDoc = randomUUID()
    const hiddenDoc = randomUUID()
    for (const [id, sub, label, createdAt] of [
      [visibleDoc, org.subsidiaryId, 'Visible', '2026-07-01T00:00:00Z'],
      [hiddenDoc, hidden, 'Hidden', '2026-07-02T00:00:00Z'],
    ] as const) {
      await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, created_at)
        values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${sub}, ${org.customerId}, ${org.date}, 'CAD', 1, ${createdAt}::timestamptz)`)
    }

    const visibleEntry = randomUUID()
    const hiddenEntry = randomUUID()
    for (const [id, sub, createdAt] of [
      [visibleEntry, org.subsidiaryId, '2026-07-01T00:00:00Z'],
      [hiddenEntry, hidden, '2026-07-02T00:00:00Z'],
    ] as const) {
      await db.execute(sql`insert into journal_entries(id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_at)
        values (${id}, ${org.orgId}, ${org.bookId}, ${sub}, ${id}, ${org.date}, ${org.periodId}, 'draft', 'manual', ${createdAt}::timestamptz)`)
    }

    // Unrestricted: the org-wide latest record.
    assert.equal(await findSamplePdfRecordId('customer_invoice', org.orgId, null), hiddenDoc)
    assert.equal(await findSamplePdfRecordId('journal_entry', org.orgId, null), hiddenEntry)

    // Restricted to the visible entity: the latest record of THAT entity.
    const scope = new Set([org.subsidiaryId])
    assert.equal(await findSamplePdfRecordId('customer_invoice', org.orgId, scope), visibleDoc)
    assert.equal(await findSamplePdfRecordId('journal_entry', org.orgId, scope), visibleEntry)

    // Empty scope: nothing real is ever sampled.
    assert.equal(await findSamplePdfRecordId('customer_invoice', org.orgId, new Set()), null)
    assert.equal(await findSamplePdfRecordId('journal_entry', org.orgId, new Set()), null)

    // This fixture contains no payroll records; neither payroll sample exists.
    assert.equal(await findSamplePdfRecordId('pay_stub', org.orgId, scope), null)
    assert.equal(await findSamplePdfRecordId('payroll_cheque', org.orgId, scope), null)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

/**
 * The field-ticket template catalog advertises a party address merge field.
 * It must print the customer's default billing address like every sibling
 * record type — never a silent blank.
 */
test('field-ticket merge values populate the customer party address', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { withBypassContext } = await import('@openbooks/engine/src/db.ts')
  const { seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
  const { createFieldTicket } = await import('../field-tickets')
  const { loadPdfRecordValues } = await import('./values')
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`insert into addresses
        (id, org_id, party_id, label, line1, city, region, postal_code, country, is_default_billing)
        values (${randomUUID()}, ${org.orgId}, ${org.customerId}, 'HQ', '400 King St W', 'Toronto', 'ON', 'M5V 1K2', 'CA', true)`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'ADDR-1', 'Address job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      const created = await createFieldTicket(org.orgId, actor, { projectId })
      const record = await loadPdfRecordValues('field_ticket', org.orgId, created.id)
      assert.equal(record?.values.party_address, '400 King St W, Toronto, ON, M5V 1K2, CA')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
