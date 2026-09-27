import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrg } from '@openbooks/engine/src/platform/db.ts'
import { postDocument } from '@openbooks/engine/src/ledger/posting-document.ts'
import { receiveInventory } from '@openbooks/engine/src/inventory/movements.ts'
import { getOnHand } from '@openbooks/engine/src/inventory/position.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { createReturnAuthorization, inspectReturnAuthorization, receiveReturnAuthorization } from './returns.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const postingDeps = (org: ScratchOrg) => ({ control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })

async function enableReturns(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"warehousing":true,"fulfillment":true,"returnAuthorizations":true}'::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function addBin(org: ScratchOrg, code: string): Promise<string> {
  const id = randomUUID()
  const result = await withBypassContext(() => db.execute(sql`
    insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
    values (${id}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, ${code}, 'bin', true) returning id`))
  assert.equal(result.rows.length, 1)
  return id
}

async function postSale(org: ScratchOrg): Promise<string[]> {
  const documentId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                             currency, fx_rate, status, subtotal, tax_total, total, custom)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-RMA-${documentId.slice(0, 8)}`}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1, 'draft', '30', '0', '30', '{}'::jsonb)`)
    for (let lineNumber = 1; lineNumber <= 3; lineNumber++) {
      const lineId = randomUUID()
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                    amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                    stock_location_id, custom, tax_overridden)
        values (${lineId}, ${org.orgId}, ${documentId}, ${lineNumber}, ${org.items.fifo}, ${org.accounts.revenue},
                '1', '10', '10', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`)
    }
    const approved = await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId} returning id`)
    assert.equal(approved.rows.length, 1)
  })
  await postDocument(documentId, postingDeps(org))
  const issues = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    select m.id from inventory_movements m join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
     where m.org_id = ${org.orgId} and l.document_id = ${documentId} and m.kind = 'issue' order by l.line_number`))).rows
  assert.equal(issues.length, 3)
  return issues.map(({ id }) => id)
}

test('RMA inspection issues one original-cost credit, scraps quarantine stock, stages vendor return and replays', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const restockBin = await addBin(org, 'RMA-RESTOCK')
    const quarantine = await addBin(org, 'RMA-QUARANTINE')
    await withOrg(org.orgId, () => receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '3', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }))
    const issueIds: string[] = []
    issueIds.push(...await withOrg(org.orgId, () => postSale(org)))
    const body = {
      partyId: org.customerId,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      lines: issueIds.map(() => ({
        accountId: org.accounts.revenue,
        itemId: org.items.fifo,
        description: 'Returned item',
        quantity: '1',
        unit: 'ea',
        unitPrice: '0',
        amount: '0',
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: '0',
        stockLocationId: org.stockLocationId,
      })),
    }
    const rma = await createReturnAuthorization({
      orgId: org.orgId,
      actorId,
      key: randomUUID(),
      body,
      requestBody: { document: body, sourceSelections: issueIds },
      sourceSelections: issueIds.map((sourceIssueMovementId, index) => ({ lineNumber: index + 1, sourceIssueMovementId })),
      allowedSubsidiaryIds: null,
    })
    const received = await receiveReturnAuthorization({
      orgId: org.orgId,
      actorId,
      documentId: rma.id,
      receivedLines: rma.lines.map(({ lineId }) => ({ lineId, received: '1' })),
      allowedSubsidiaryIds: null,
    })
    assert.equal(received.stage, 'receiving')
    const inspectionLines = rma.lines.map((line, index) => ({
      lineId: line.lineId,
      accepted: '1',
      disposition: (['restock', 'scrap', 'vendor-return'] as const)[index]!,
      dispositionLocationId: index === 0 ? restockBin : quarantine,
      ...(index === 2 ? { vendorId: org.vendorId } : {}),
    }))
    const inspected = await inspectReturnAuthorization({
      orgId: org.orgId,
      actorId,
      documentId: rma.id,
      inspectionLines,
      allowedSubsidiaryIds: null,
    })
    assert.equal(inspected.awaitingCreditApproval, false)
    assert.equal(inspected.authorization.stage, 'done')
    assert.ok(inspected.authorization.customerCreditId)
    const stock = await getOnHand(org.orgId, org.items.fifo, restockBin)
    assert.equal(stock.quantity, '1.0000')
    assert.equal(stock.unitCost, '4.0000')
    const receipts = (await db.execute<{ quantity: string; total_value: string; stock_location_id: string }>(sql`
      select m.quantity::text, m.total_value::text, m.stock_location_id
        from inventory_movements m join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
       where m.org_id = ${org.orgId} and l.document_id = ${inspected.authorization.customerCreditId} and m.kind = 'receipt'
       order by m.stock_location_id`)).rows
    assert.equal(receipts.length, 3)
    assert.deepEqual(receipts.map((row) => row.total_value), ['4.0000', '4.0000', '4.0000'])
    assert.equal((await getOnHand(org.orgId, org.items.fifo, quarantine)).quantity, '1.0000', 'scrap leaves one vendor-return unit in quarantine')
    const linkedDraft = (await db.execute<{ id: string; status: string; links: number }>(sql`
      select d.id, d.status,
             (select count(*)::int from document_links l where l.org_id = d.org_id and l.from_document_id = ${rma.id}
               and l.to_document_id = d.id and l.link_type = 'created_from') as links
        from documents d join rma_lines r on r.vendor_credit_id = d.id and r.org_id = d.org_id
       where r.org_id = ${org.orgId} and r.document_id = ${rma.id} and r.disposition = 'vendor-return'`)).rows[0]
    assert.ok(linkedDraft)
    assert.equal(linkedDraft.status, 'draft')
    assert.equal(linkedDraft.links, 1)
    const scrap = (await db.execute<{ quantity: string; total_value: string }>(sql`
      select m.quantity::text, m.total_value::text from rma_lines r
        join inventory_movements m on m.id = r.scrap_movement_id and m.org_id = r.org_id
       where r.org_id = ${org.orgId} and r.document_id = ${rma.id} and r.disposition = 'scrap'`)).rows[0]
    assert.ok(scrap)
    assert.equal(scrap.quantity, '-1.0000')
    assert.equal(scrap.total_value, '-4.0000')
    const replay = await inspectReturnAuthorization({ orgId: org.orgId, actorId, documentId: rma.id, inspectionLines, allowedSubsidiaryIds: null })
    assert.equal(replay.authorization.customerCreditId, inspected.authorization.customerCreditId)
    const credits = await db.execute(sql`select id from documents where org_id = ${org.orgId} and kind = 'customer_credit'`)
    assert.equal(credits.rows.length, 1)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
