import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '../db.ts'
import { createScratchOrg, dropScratchOrg } from '../test-fixtures.ts'
import { loadDocument, loadDocumentEditCurrent } from './document-service.ts'

const DB = !!process.env.OPENBOOKS_DB_URL

test('explicit-org document reads isolate tenants and preserve exact revisions', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const id = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, subsidiary_id,
          party_id, document_date, currency, subtotal, tax_total, total)
        values (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'SERVICE-READ', ${org.subsidiaryId},
          ${org.vendorId}, ${org.date}, 'CAD', '0', '0', '0')
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
    assert.deepEqual(loaded.lines, [])
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
