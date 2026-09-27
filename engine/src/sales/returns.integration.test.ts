import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrg } from '../platform/db.ts'
import { postDocument } from '../ledger/posting-document.ts'
import { receiveInventory } from '../inventory/movements.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '../testing/fixtures.ts'
import {
  authorizeReturn,
  getReturnAuthorization,
  receiveReturn,
  ReturnRefusal,
} from './returns.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const postingDeps = (org: ScratchOrg) => ({ control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })

async function enableReturns(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"warehousing": true, "fulfillment": true, "returnAuthorizations": true}'::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function postedSale(org: ScratchOrg, quantity: string): Promise<{ documentId: string; issueId: string }> {
  const documentId = randomUUID()
  const lineId = randomUUID()
  const amount = quantity === '10' ? '100' : '110'
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${amount}, '0', ${amount}, '{}'::jsonb)`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, ${quantity},
            '10', ${amount}, '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`)
  const approved = await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId} returning id`)
  assert.equal(approved.rows.length, 1)
  await postDocument(documentId, postingDeps(org))
  const issue = (await db.execute<{ id: string }>(sql`
    select id from inventory_movements where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0]
  assert.ok(issue)
  return { documentId, issueId: issue.id }
}

async function draftReturn(
  org: ScratchOrg,
  actorId: string,
  sourceDocumentId: string,
  quantity: string,
): Promise<{ id: string; lineId: string; number: string }> {
  const id = randomUUID()
  const lineId = randomUUID()
  const number = `RMA-${id.slice(0, 8)}`
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                           status, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'rma', ${number}, ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD',
            'draft', '0', '0', '0', ${actorId})`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
                                unit, unit_price, amount, tax_amount, stock_location_id)
    values (${lineId}, ${org.orgId}, ${id}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Returned item',
            ${quantity}, 'ea', '0', '0', '0', ${org.stockLocationId})`)
  return { id, lineId, number }
}

async function fullyReturnSale(org: ScratchOrg, issueId: string, quantity: string): Promise<string> {
  const id = randomUUID()
  const lineId = randomUUID()
  const number = `CM-${id.slice(0, 8)}`
  const amount = quantity === '10' ? '100' : '0'
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'customer_credit', ${number}, ${org.customerId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${amount}, '0', ${amount}, '{}'::jsonb)`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${id}, 1, ${org.items.fifo}, ${org.accounts.revenue}, ${quantity}, '10',
            ${amount}, '0', false, '0', '0', ${org.stockLocationId},
            ${JSON.stringify({ inventoryReturn: { sourceIssueMovementId: issueId } })}::jsonb, false)`)
  const approved = await db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId} returning id`)
  assert.equal(approved.rows.length, 1)
  await postDocument(id, postingDeps(org))
  return number
}

test('return authorizations enforce source limits, lifecycle and organization scope', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    await enableReturns(other.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    await withOrg(org.orgId, () => receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '10', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }))
    const sale = await withOrg(org.orgId, () => postedSale(org, '10'))
    const tooMany = await withOrg(org.orgId, () => draftReturn(org, actorId, sale.documentId, '11'))
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) => authorizeReturn(tx, org.orgId, actorId, tooMany.id,
        [{ lineNumber: 1, sourceIssueMovementId: sale.issueId }], null))),
      (error: unknown) => error instanceof ReturnRefusal && error.code === 'exceeds_returnable_quantity'
        && error.status === 409 && /Reduce the authorized quantity/.test(error.remedy ?? ''),
    )

    const accepted = await withOrg(org.orgId, () => draftReturn(org, actorId, sale.documentId, '4'))
    const authorization = await withOrg(org.orgId, () => db.transaction((tx) => authorizeReturn(tx, org.orgId, actorId,
      accepted.id, [{ lineNumber: 1, sourceIssueMovementId: sale.issueId }], null)))
    assert.equal(authorization.stage, 'requested')
    const received = await withOrg(org.orgId, () => db.transaction((tx) => receiveReturn(tx, org.orgId, actorId,
      accepted.id, [{ lineId: accepted.lineId, received: '3' }], null)))
    assert.equal(received.stage, 'receiving')
    assert.equal(received.lines[0]?.received, '3.00000000')
    await assert.rejects(withOrg(org.orgId, () => db.transaction((tx) => receiveReturn(tx, org.orgId, actorId,
      accepted.id, [{ lineId: accepted.lineId, received: '1' }], null))),
      (error: unknown) => error instanceof ReturnRefusal && error.code === 'wrong_stage')

    await assert.rejects(withOrg(other.orgId, () => getReturnAuthorization(db, other.orgId, accepted.id, null)),
      (error: unknown) => error instanceof ReturnRefusal && error.code === 'not_found' && error.status === 404)

    const creditNumber = await withOrg(org.orgId, () => fullyReturnSale(org, sale.issueId, '10'))
    const afterCredit = await withOrg(org.orgId, () => draftReturn(org, actorId, sale.documentId, '1'))
    await assert.rejects(withOrg(org.orgId, () => db.transaction((tx) => authorizeReturn(tx, org.orgId, actorId,
      afterCredit.id, [{ lineNumber: 1, sourceIssueMovementId: sale.issueId }], null))),
      (error: unknown) => error instanceof ReturnRefusal && error.code === 'source_fully_returned'
        && error.message.includes(creditNumber) && /review the named customer credit/i.test(error.remedy ?? ''))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
    await withBypassContext(() => dropScratchOrg(other.orgId))
  }
})
