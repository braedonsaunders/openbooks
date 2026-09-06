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
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { attachExisting, detachAttachment, getAttachmentLink } = await import('./file-cabinet')

/**
 * Retention: purgeFile/purgeFolder refuse to destroy a file that evidences a
 * posted document. Detaching is the other half of that guarantee — if a link
 * to a posted document could be removed, the file would become purgeable and
 * the posted record would silently lose its supporting evidence. The service
 * must refuse, and a permitted detach must leave attributable evidence.
 */
test('detachAttachment retains links to posted documents and audits permitted detaches', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
    const folderId = randomUUID()
    const fileId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name) values (${folderId}, ${org.orgId}, null, 'Evidence')`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'evidence.txt', 'text/plain', 8)`)

    const seedInvoice = async (label: string): Promise<string> => {
      const id = randomUUID()
      await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
        values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
      await db.execute(sql`insert into document_lines(org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, 100, 100, 0, 0)`)
      return id
    }
    const postedDoc = await seedInvoice('Posted')
    await db.execute(sql`update documents set status = 'approved' where id = ${postedDoc}`)
    await postDocument(postedDoc, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
    const draftDoc = await seedInvoice('Draft')

    const postedLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: postedDoc, createdBy: actorId })
    const draftLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: draftDoc, createdBy: actorId })
    assert.ok(postedLink && draftLink)

    // The posted document's evidence is retained.
    assert.deepEqual(await detachAttachment(org.orgId, postedLink, { actorId }), { ok: false, reason: 'retained' })
    assert.ok(await getAttachmentLink(org.orgId, postedLink), 'the posted link survives')
    const retainedAudit = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_log
       where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${postedLink}`)).rows[0]!
    assert.equal(retainedAudit.count, 0, 'a refused detach writes no mutation evidence')

    // The draft document's link can be removed, with attributable evidence.
    assert.deepEqual(await detachAttachment(org.orgId, draftLink, { actorId }), { ok: true })
    assert.equal(await getAttachmentLink(org.orgId, draftLink), null)
    const evidence = (await db.execute<{ actor_id: string | null; changes: Record<string, unknown> }>(sql`
      select actor_id, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${draftLink}`)).rows
    assert.equal(evidence.length, 1, 'exactly one evidence row for the detach')
    assert.equal(evidence[0]!.actor_id, actorId)
    assert.equal(evidence[0]!.changes.event, 'delete')
    assert.deepEqual(evidence[0]!.changes.before, { fileId, targetTable: 'documents', targetId: draftDoc })

    // Unknown / foreign ids are plain not-found.
    assert.deepEqual(await detachAttachment(org.orgId, randomUUID(), { actorId }), { ok: false, reason: 'not found' })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
