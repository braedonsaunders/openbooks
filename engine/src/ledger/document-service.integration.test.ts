import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '../testing/fixtures.ts'
import { loadDocument, loadDocumentEditCurrent } from './document-service.ts'

const DB = !!process.env.OPENBOOKS_DB_URL

test('explicit-org document reads isolate tenants and preserve exact revisions', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const id = randomUUID()
    const lineId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, subsidiary_id,
          party_id, document_date, currency, subtotal, tax_total, total)
        values (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'SERVICE-READ', ${org.subsidiaryId},
          ${org.vendorId}, ${org.date}, 'CAD', '7', '0', '7')
      `)
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id,
          description, quantity, unit_price, amount, tax_input_amount, tax_amount,
          tax_overridden, extra_dims, custom)
        values (${lineId}, ${org.orgId}, ${id}, 1, ${org.accounts.bank},
          'Retained detail', '1', '7', '7', '7', '0', false, '{}'::jsonb,
          '{"source":"boundary-test"}'::jsonb)
      `)
    })
    const loaded = await withOrgContext(org.orgId, () => loadDocument(id, org.orgId))
    const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId))
    assert.ok(loaded)
    assert.ok(current)
    assert.equal(loaded.doc.id, id)
    assert.equal(loaded.doc.org_id, org.orgId)
    assert.match(current.updatedAt, /^\d+$/)
    assert.equal(loaded.doc.updated_at, current.updatedAt)
    assert.equal(loaded.doc.applied, null)
    assert.equal(loaded.doc.balance_due, null)
    assert.equal(loaded.lines.length, 1)
    const line = loaded.lines[0]!
    assert.equal(line.id, lineId)
    assert.equal(line.account_id, org.accounts.bank)
    assert.equal(line.line_number, 1)
    assert.equal(line.description, 'Retained detail')
    assert.match(String(line.amount), /^7(?:\.0+)?$/)
    assert.deepEqual(line.custom, { source: 'boundary-test' })
    for (const column of ['stock_location_id', 'distribution_group_id', 'distribution_rule_id',
      'distribution_version_id', 'distribution_locked', 'distribution_rule_name']) {
      assert.ok(Object.hasOwn(line, column), `${column} remains projected`)
    }
    // Bypass RLS deliberately: explicit SQL org predicates must independently
    // reject a foreign org, even for trusted background engine callers.
    await withBypassContext(async () => {
      const foreignOrg = randomUUID()
      assert.equal(await loadDocument(id, foreignOrg), null)
      assert.equal(await loadDocumentEditCurrent(id, foreignOrg), null)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
