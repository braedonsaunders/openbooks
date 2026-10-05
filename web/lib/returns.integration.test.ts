import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrg } from '@openbooks/engine/src/platform/db.ts'
import { postDocument } from '@openbooks/engine/src/ledger/posting-document.ts'
import { receiveInventory } from '@openbooks/engine/src/inventory/movements.ts'
import { getOnHand } from '@openbooks/engine/src/inventory/position.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { ReturnRefusal } from '@openbooks/engine/src/sales/returns.ts'
import { convertOrder, fulfillSalesOrder } from './order-cycle.ts'
import { createReturnAuthorization, inspectReturnAuthorization, previewReturnRestockingFee, receiveReturnAuthorization } from './returns.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const postingDeps = (org: ScratchOrg) => ({ control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })

async function enableReturns(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"orders":true,"warehousing":true,"fulfillment":true,"returnAuthorizations":true}'::jsonb) where id = ${orgId} returning id`))
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
  const stockBefore = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)
  assert.equal(stockBefore.quantity, '3.0000', 'return source fixture has three units before invoice posting')
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
  const stockAfter = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)
  assert.equal(stockAfter.quantity, '0.0000', 'posting consumed the three shipped units')
  // postSale runs inside the caller-owned transaction. Read its pending
  // movement evidence on that same connection before the transaction commits.
  const issues = (await db.execute<{ id: string }>(sql`
    select m.id from inventory_movements m join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
     where m.org_id = ${org.orgId} and l.document_id = ${documentId} and m.kind = 'issue' order by l.line_number`)).rows
  const movementEvidence = (await db.execute(sql`
    select id, kind, document_line_id, quantity::text as quantity from inventory_movements
    where org_id = ${org.orgId} and item_id = ${org.items.fifo} order by moved_at, id`)).rows
  assert.equal(issues.length, 3, JSON.stringify({ stockBefore, stockAfter, movementEvidence }))
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

test('RMA against an order-governed shipment credits the posted invoice price and refuses before invoicing', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const restockBin = await addBin(org, 'RMA-RESTOCK')
    const taxCodeId = randomUUID()
    const orderId = randomUUID()
    const orderLineId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into tax_codes (id, org_id, code, name, is_active, collected_account_id, paid_account_id)
        values (${taxCodeId}, ${org.orgId}, 'RMA-13', 'Sales tax 13%', true, ${org.accounts.taxOutput}, ${org.accounts.taxInput})`)
      await db.execute(sql`insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from) values (${org.orgId}, ${taxCodeId}, '13', '2000-01-01')`)
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                               status, subtotal, tax_total, total, created_by, updated_by)
        values (${orderId}, ${org.orgId}, 'sales_order', 'SO-RMA-1', ${org.customerId}, ${org.subsidiaryId}, ${org.date},
                'CAD', 'draft', '1000', '130', '1130', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
                                    unit_price, amount, tax_input_amount, tax_code_id, tax_amount, quantity_billed,
                                    quantity_fulfilled, stock_location_id, created_by, updated_by)
        values (${orderLineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Widget', '10', 'ea',
                '100', '1000', '1000', ${taxCodeId}, '130', '0', '0', ${org.stockLocationId}, ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into document_line_tax_components (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
                                                  tax_amount, nonrecoverable_amount, calculation_type, collected_account_id, paid_account_id)
        values (${org.orgId}, ${orderLineId}, ${taxCodeId}, 1, '13', '1000', '130', '130', 'standard', ${org.accounts.taxOutput}, ${org.accounts.taxInput})`)
      const approved = await db.execute(sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId} returning id`)
      assert.equal(approved.rows.length, 1)
    })
    await withOrg(org.orgId, () => receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '10', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }))
    const shipment = await withOrg(org.orgId, () => fulfillSalesOrder(org.orgId, actorId, orderId, {
      fulfillmentDate: org.date, idempotencyKey: 'rma-order-ship', lines: [{ sourceLineId: orderLineId, quantity: '10' }],
    }))
    const issueId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      select m.id from inventory_movements m join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
       where m.org_id = ${org.orgId} and l.document_id = ${shipment.id} and m.kind = 'issue' and m.status = 'posted'`))).rows
    assert.equal(issueId.length, 1, 'the shipment issued the ten units once')
    const body = {
      partyId: org.customerId, subsidiaryId: org.subsidiaryId, documentDate: org.date,
      lines: [{
        accountId: org.accounts.revenue, itemId: org.items.fifo, description: 'Returned widget', quantity: '5', unit: 'ea',
        unitPrice: '0', amount: '0', taxCodeId: null, taxGroupId: null, taxOverridden: false, taxAmount: '0',
        stockLocationId: org.stockLocationId,
      }],
    }
    const rma = await createReturnAuthorization({
      orgId: org.orgId, actorId, key: randomUUID(), body, requestBody: { document: body, sourceSelections: [issueId[0]!.id] },
      sourceSelections: [{ lineNumber: 1, sourceIssueMovementId: issueId[0]!.id }], allowedSubsidiaryIds: null,
    })
    await receiveReturnAuthorization({
      orgId: org.orgId, actorId, documentId: rma.id, receivedLines: [{ lineId: rma.lines[0]!.lineId, received: '5' }], allowedSubsidiaryIds: null,
    })
    const inspectionLines = [{ lineId: rma.lines[0]!.lineId, accepted: '5', disposition: 'restock' as const, dispositionLocationId: restockBin }]
    const inspect = () => inspectReturnAuthorization({ orgId: org.orgId, actorId, documentId: rma.id, inspectionLines, allowedSubsidiaryIds: null })
    await assert.rejects(inspect(), (error: unknown) => {
      assert.ok(error instanceof ReturnRefusal)
      assert.equal(error.code, 'source_unavailable')
      assert.match(error.message, new RegExp(`shipped on ${shipment.documentNumber} that no posted customer invoice has billed from SO-RMA-1`))
      assert.equal(error.remedy, 'Invoice the shipped goods from SO-RMA-1 and post that invoice, then inspect the return again')
      return true
    }, 'an un-invoiced shipment has no price to credit, so inspection refuses instead of crediting zero')

    const invoice = await convertOrder(org.orgId, actorId, orderId, 'customer_invoice')
    await withBypassContext(async () => {
      const approved = await db.execute(sql`update documents set status = 'approved' where id = ${invoice.id} and org_id = ${org.orgId} returning id`)
      assert.equal(approved.rows.length, 1)
      await postDocument(invoice.id, postingDeps(org))
    })
    const inspected = await inspect()
    assert.equal(inspected.authorization.stage, 'done')
    const credit = (await db.execute<Record<string, unknown>>(sql`
      select quantity::text, amount::text, tax_amount::text, account_id, tax_code_id
        from document_lines where org_id = ${org.orgId} and document_id = ${inspected.authorization.customerCreditId}`)).rows
    assert.deepEqual(credit, [{
      quantity: '5.00000000', amount: '500.0000', tax_amount: '65.0000', account_id: org.accounts.revenue, tax_code_id: taxCodeId,
    }], 'half the invoiced units credit half the invoiced price and tax on the billed income account and tax code')
    assert.equal((await getOnHand(org.orgId, org.items.fifo, restockBin)).quantity, '5.0000')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('BHD return prices ISO fils through preview and inspect', { skip: !DB }, async () => {
  // Caller-level agreement in fils: the RMA header currency is asserted BHD
  // so this cannot pass as CAD smoke. A 10.000 BHD sale line credits
  // original cost 4.0000 as 4000 fils through the registry quantum; a fixed
  // 1000-fil policy resolves 1000 fils per line with minorUnits 3; preview
  // and the inspect write path agree on the total and the -1.0000 lines.
  await withBypassContext(async () => {
    await db.execute(sql`insert into currencies (code, name, minor_units)
      values ('BHD', 'Bahraini Dinar', 3) on conflict (code) do nothing`)
    const rows = (await db.execute<{ code: string; minor_units: number }>(sql`
      select code, minor_units from currencies where code = 'BHD'`)).rows
    assert.deepEqual(rows, [{ code: 'BHD', minor_units: 3 }])
  })
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const restockBin = await addBin(org, 'RMA-RESTOCK-BHD')
    await withOrg(org.orgId, () => receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '3', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }))
    const documentId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'BHD', 'CAD', ${org.date}::date, 'spot', 1, 'manual')`)
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                               currency, fx_rate, status, subtotal, tax_total, total, custom)
        values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-RMA-BHD-${documentId.slice(0, 8)}`}, ${org.customerId},
                ${org.subsidiaryId}, ${org.date}, ${org.date}, 'BHD', 1, 'draft', '30.000', '0', '30.000', '{}'::jsonb)`)
      for (let lineNumber = 1; lineNumber <= 3; lineNumber++) {
        const lineId = randomUUID()
        await db.execute(sql`
          insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                      amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                      stock_location_id, custom, tax_overridden)
          values (${lineId}, ${org.orgId}, ${documentId}, ${lineNumber}, ${org.items.fifo}, ${org.accounts.revenue},
                  '1', '10.000', '10.000', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`)
      }
      const approved = await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId} returning id`)
      assert.equal(approved.rows.length, 1)
    })
    await postDocument(documentId, postingDeps(org))
    const issues = (await db.execute<{ id: string }>(sql`
      select m.id from inventory_movements m join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
       where m.org_id = ${org.orgId} and l.document_id = ${documentId} and m.kind = 'issue' order by l.line_number`)).rows
    assert.equal(issues.length, 3)
    const body = {
      partyId: org.customerId,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: 'BHD',
      lines: issues.map(() => ({
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
      requestBody: { document: body, sourceSelections: issues.map((issue) => issue.id) },
      sourceSelections: issues.map((issue, index) => ({ lineNumber: index + 1, sourceIssueMovementId: issue.id })),
      allowedSubsidiaryIds: null,
    })
    const header = (await db.execute<{ currency: string }>(sql`
      select currency from documents where org_id = ${org.orgId} and id = ${rma.id}`)).rows[0]
    assert.equal(header?.currency, 'BHD')
    await receiveReturnAuthorization({
      orgId: org.orgId,
      actorId,
      documentId: rma.id,
      receivedLines: rma.lines.map(({ lineId }) => ({ lineId, received: '1' })),
      allowedSubsidiaryIds: null,
    })
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into restocking_fee_policies
          (id, org_id, item_category, item_id, kind, fee_percent, fee_amount_minor,
           currency, income_account_id, effective_from, effective_to, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, null, null, 'fixed', null, '1000',
                'BHD', ${org.accounts.revenue}, '2020-01-01', null, ${actorId}, ${actorId})`)
    })
    const preview = await previewReturnRestockingFee({
      orgId: org.orgId,
      documentId: rma.id,
      lines: rma.lines.map(({ lineId }) => ({ lineId, accepted: '1' })),
      allowedSubsidiaryIds: null,
    })
    assert.equal(preview.currency, 'BHD')
    assert.equal(preview.minorUnits, 3)
    assert.equal(preview.totalMinor, '3000')
    const inspected = await inspectReturnAuthorization({
      orgId: org.orgId,
      actorId,
      documentId: rma.id,
      inspectionLines: rma.lines.map(({ lineId }) => ({
        lineId, accepted: '1', disposition: 'restock' as const, dispositionLocationId: restockBin,
      })),
      allowedSubsidiaryIds: null,
    })
    assert.equal(inspected.authorization.stage, 'done')
    const feeLines = (await db.execute<{ amount: string }>(sql`
      select amount::text from document_lines
       where org_id = ${org.orgId} and document_id = ${inspected.authorization.customerCreditId} and amount::numeric < 0
       order by line_number`)).rows
    assert.deepEqual(feeLines.map((line) => line.amount), ['-1.0000', '-1.0000', '-1.0000'])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
