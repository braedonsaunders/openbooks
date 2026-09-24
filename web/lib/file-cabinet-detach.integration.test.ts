import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import pg from 'pg'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { attachExisting, detachAttachment, getAttachmentLink } = await import('./file-cabinet')

test('detachAttachment retains links to posted documents and audits permitted detaches', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Clerk', 'clerk')
    const folderId = randomUUID()
    const fileId = randomUUID()
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name) values (${folderId}, ${org.orgId}, null, 'Evidence')`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes) values (${fileId}, ${org.orgId}, ${folderId}, 'evidence.txt', 'text/plain', 8)`)

    const seedInvoice = async (label: string): Promise<string> => {
      const id = randomUUID()
      await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate) values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${label}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
      await db.execute(sql`insert into document_lines(org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount) values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, 100, 100, 0, 0)`)
      return id
    }
    const postedDoc = await seedInvoice('Posted')
    await db.execute(sql`update documents set status = 'approved' where id = ${postedDoc}`)
    await postDocument(postedDoc, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
    const draftDoc = await seedInvoice('Draft')
    const raceDoc = await seedInvoice('Race')

    const postedLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: postedDoc, createdBy: actorId })
    const draftLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: draftDoc, createdBy: actorId })
    const raceLink = await attachExisting({ orgId: org.orgId, fileId, targetTable: 'documents', targetId: raceDoc, createdBy: actorId })
    assert.ok(postedLink && draftLink && raceLink)

    assert.deepEqual(await detachAttachment(org.orgId, postedLink, { actorId }), { ok: false, reason: 'retained' })
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${postedLink}`)).rows[0]!.count, 0)

    assert.deepEqual(await detachAttachment(org.orgId, draftLink, { actorId }), { ok: true })
    assert.equal(await getAttachmentLink(org.orgId, draftLink), null)
    const evidence = (await db.execute<{ actor_id: string | null; changes: Record<string, unknown> }>(sql`select actor_id, changes from audit_log where org_id = ${org.orgId} and table_name = 'file_attachments' and row_id = ${draftLink}`)).rows
    assert.deepEqual(evidence.map((row) => [row.actor_id, row.changes.event, row.changes.before]), [[actorId, 'delete', { fileId, targetTable: 'documents', targetId: draftDoc }]])

    const client = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL })
    await client.connect()
    let detached = false
    try {
      await client.query('begin')
      await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)", [org.orgId])
      await client.query('select id from documents where id = $1 and org_id = $2 for update', [raceDoc, org.orgId])
      const pendingDetach = detachAttachment(org.orgId, raceLink!, { actorId }).then((result) => { detached = true; return result })
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(detached, false)
      await client.query('commit')
      assert.deepEqual(await pendingDetach, { ok: true })
    } finally {
      await client.query('rollback').catch(() => undefined)
      await client.end()
    }

  } finally {
    await dropScratchOrg(org.orgId)
  }
})
