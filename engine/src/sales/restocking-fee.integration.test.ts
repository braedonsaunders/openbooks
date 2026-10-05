import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrg } from '../platform/db.ts'
import { postDocument } from '../ledger/posting-document.ts'
import { receiveInventory } from '../inventory/movements.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '../testing/fixtures.ts'
import { authorizeReturn, completeReturnInspection, receiveReturn, recordReturnInspection } from './returns.ts'
import {
  checkRestockingPolicyOverlap,
  recordRestockingFeeWaiver,
  resolveRestockingFee,
  restockingFeeCreditLines,
  RestockingFeeRefusal,
} from './restocking-fees.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const postingDeps = (org: ScratchOrg) => ({ control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })

async function enableReturns(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"warehousing": true, "fulfillment": true, "returnAuthorizations": true}'::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function insertPolicy(org: ScratchOrg, actorId: string, policy: {
  itemCategory?: string | null
  itemId?: string | null
  kind: 'percent' | 'fixed'
  feePercent?: string | null
  feeAmountMinor?: string | null
  currency?: string | null
  effectiveFrom: string
  effectiveTo?: string | null
}): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into restocking_fee_policies (id, org_id, item_category, item_id, kind, fee_percent, fee_amount_minor,
                                         currency, income_account_id, effective_from, effective_to, created_by, updated_by)
    values (${id}, ${org.orgId}, ${policy.itemCategory ?? null}, ${policy.itemId ?? null}, ${policy.kind},
            ${policy.feePercent ?? null}, ${policy.feeAmountMinor ?? null}, ${policy.currency ?? null},
            ${org.accounts.revenue}, ${policy.effectiveFrom}, ${policy.effectiveTo ?? null}, ${actorId}, ${actorId})`)
  return id
}

async function postedSale(org: ScratchOrg): Promise<{ documentId: string; issueId: string }> {
  const documentId = randomUUID()
  const lineId = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1, 'draft', '100', '0', '100', '{}'::jsonb)`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, '10',
            '10', '100', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`)
  const approved = await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId} returning id`)
  assert.equal(approved.rows.length, 1)
  await postDocument(documentId, postingDeps(org))
  const issue = (await db.execute<{ id: string }>(sql`
    select id from inventory_movements where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0]
  assert.ok(issue)
  return { documentId, issueId: issue.id }
}

async function draftReturn(org: ScratchOrg, actorId: string): Promise<{ id: string; lineId: string }> {
  const id = randomUUID()
  const lineId = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                           status, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'rma', ${`RMA-${id.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
            ${org.date}, 'CAD', 'draft', '0', '0', '0', ${actorId})`)
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
                                unit, unit_price, amount, tax_amount, stock_location_id)
    values (${lineId}, ${org.orgId}, ${id}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Returned item',
            '10', 'ea', '0', '0', '0', ${org.stockLocationId})`)
  return { id, lineId }
}

test('effective policy is chosen by return date and scope rank', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    // Three policies that overlap in time but differ in scope: the item
    // policy must win for its item, the category policy for the same
    // category on another item, the default everywhere else.
    await insertPolicy(org, actorId, { itemId: org.items.fifo, kind: 'percent', feePercent: '10', effectiveFrom: '2020-01-01' })
    await insertPolicy(org, actorId, { itemCategory: 'Electronics', kind: 'percent', feePercent: '5', effectiveFrom: '2020-01-01' })
    await insertPolicy(org, actorId, { kind: 'fixed', feeAmountMinor: '200', effectiveFrom: '2020-01-01' })
    // A newer default that only governs 2026: resolving in 2025 must still
    // find the standing default, resolving in 2026 the newer one.
    await insertPolicy(org, actorId, { kind: 'fixed', feeAmountMinor: '700', effectiveFrom: '2026-01-01' })
    const at = async (returnDate: string, itemId: string | null, itemCategory: string | null) =>
      withOrg(org.orgId, () => resolveRestockingFee(db, org.orgId, {
        returnDate, currency: 'CAD',
        lines: [{ key: 'l1', itemId, itemCategory, lineTotalMinor: 10000n }],
        waived: false, canWaive: false,
      }))
    const item = await at('2025-06-01', org.items.fifo, 'Electronics')
    assert.equal(item.lines[0]?.scope, 'item')
    assert.equal(item.lines[0]?.feeMinor, '1000')
    const category = await at('2025-06-01', org.items.service, 'Electronics')
    assert.equal(category.lines[0]?.scope, 'category')
    assert.equal(category.lines[0]?.feeMinor, '500')
    const oldDefault = await at('2025-06-01', org.items.service, 'Furniture')
    assert.equal(oldDefault.lines[0]?.scope, 'default')
    assert.equal(oldDefault.lines[0]?.feeMinor, '200')
    const newDefault = await at('2026-06-01', org.items.service, 'Furniture')
    assert.equal(newDefault.lines[0]?.feeMinor, '700')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('waive requires the grant and a reason, and is audited', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    await insertPolicy(org, actorId, { kind: 'percent', feePercent: '10', effectiveFrom: '2020-01-01' })
    const line = { key: 'l1', itemId: null, itemCategory: null, lineTotalMinor: 10000n }
    await assert.rejects(
      withOrg(org.orgId, () => resolveRestockingFee(db, org.orgId, {
        returnDate: '2026-06-01', currency: 'CAD', lines: [line], waived: true, waiveReason: 'Goodwill', canWaive: false,
      })),
      (error: unknown) => error instanceof RestockingFeeRefusal && error.code === 'waive_forbidden'
        && error.status === 409 && /fee waiver/.test(error.remedy ?? ''),
    )
    await assert.rejects(
      withOrg(org.orgId, () => resolveRestockingFee(db, org.orgId, {
        returnDate: '2026-06-01', currency: 'CAD', lines: [line], waived: true, canWaive: true,
      })),
      (error: unknown) => error instanceof RestockingFeeRefusal && error.code === 'waive_reason_required'
        && error.status === 422 && /reason/.test(error.message),
    )
    const waived = await withOrg(org.orgId, () => resolveRestockingFee(db, org.orgId, {
      returnDate: '2026-06-01', currency: 'CAD', lines: [line], waived: true, waiveReason: 'Damaged in transit', canWaive: true,
    }))
    assert.equal(waived.totalMinor, '0')
    assert.equal(restockingFeeCreditLines(waived).length, 0)
    const rmaId = randomUUID()
    await withOrg(org.orgId, () => recordRestockingFeeWaiver(db, org.orgId, actorId, rmaId, {
      totalMinor: '1000', currency: 'CAD', reason: 'Damaged in transit',
    }))
    const audit = (await db.execute<{ changes: { reason: string } }>(sql`
      select changes from audit_log where org_id = ${org.orgId} and table_name = 'rma_documents' and row_id = ${rmaId}`)).rows
    assert.equal(audit.length, 1)
    assert.equal(audit[0]?.changes.reason, 'Damaged in transit')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('overlapping open policies are refused under lock', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const first = await insertPolicy(org, actorId, { kind: 'percent', feePercent: '10', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) => checkRestockingPolicyOverlap(tx, org.orgId, {
        effectiveFrom: '2026-06-01', effectiveTo: '2026-12-31',
      }))),
      (error: unknown) => error instanceof RestockingFeeRefusal && /2026-01-01/.test(error.message)
        && /End the existing policy/.test(error.remedy ?? ''),
    )
    // A later window, another scope, and the policy's own edit all pass.
    await withOrg(org.orgId, () => db.transaction((tx) => checkRestockingPolicyOverlap(tx, org.orgId, {
      effectiveFrom: '2026-07-01', effectiveTo: null,
    })))
    await withOrg(org.orgId, () => db.transaction((tx) => checkRestockingPolicyOverlap(tx, org.orgId, {
      itemCategory: 'Electronics', effectiveFrom: '2026-06-01', effectiveTo: null,
    })))
    await withOrg(org.orgId, () => db.transaction((tx) => checkRestockingPolicyOverlap(tx, org.orgId, {
      effectiveFrom: '2026-06-01', effectiveTo: null, ignoreId: first,
    })))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('inspected credit equals returned value minus fee and balances', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableReturns(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    await withOrg(org.orgId, () => receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: '10', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }))
    const sale = await withOrg(org.orgId, () => postedSale(org))
    await insertPolicy(org, actorId, { kind: 'percent', feePercent: '10', effectiveFrom: '2000-01-01' })
    const rma = await withOrg(org.orgId, () => draftReturn(org, actorId))
    await withOrg(org.orgId, () => db.transaction((tx) => authorizeReturn(tx, org.orgId, actorId,
      rma.id, [{ lineNumber: 1, sourceIssueMovementId: sale.issueId }], null)))
    await withOrg(org.orgId, () => db.transaction((tx) => receiveReturn(tx, org.orgId, actorId,
      rma.id, [{ lineId: rma.lineId, received: '10' }], null)))
    // Ten units at ten dollars credited, ten percent fee: the credit is 90.
    const resolution = await withOrg(org.orgId, () => resolveRestockingFee(db, org.orgId, {
      returnDate: org.date, currency: 'CAD',
      lines: [{ key: rma.lineId, itemId: org.items.fifo, itemCategory: null, lineTotalMinor: 10000n }],
      waived: false, canWaive: false,
    }))
    assert.equal(resolution.totalMinor, '1000')
    const feeLines = restockingFeeCreditLines(resolution)
    assert.equal(feeLines.length, 1)
    const creditId = randomUUID()
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                             status, subtotal, tax_total, total, custom)
      values (${creditId}, ${org.orgId}, 'customer_credit', ${`CM-${creditId.slice(0, 8)}`}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '0', '0', '0', '{}'::jsonb)`)
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                  stock_location_id, custom, tax_overridden)
      values (${randomUUID()}, ${org.orgId}, ${creditId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, '10',
              '10', '100', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, true)`)
    const fee = feeLines[0]!
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed, custom, tax_overridden)
      values (${randomUUID()}, ${org.orgId}, ${creditId}, 2, ${fee.accountId}, ${fee.description}, '1',
              ${fee.unitPrice}, ${fee.amount}, '0', false, '0', '0', '{}'::jsonb, true)`)
    await withOrg(org.orgId, () => db.transaction((tx) => recordReturnInspection(tx, org.orgId, actorId,
      rma.id, [{ lineId: rma.lineId, accepted: '10', disposition: 'restock', dispositionLocationId: org.stockLocationId }], creditId, null)))
    const approved = await db.execute(sql`update documents set status = 'approved' where id = ${creditId} and org_id = ${org.orgId} returning id`)
    assert.equal(approved.rows.length, 1)
    await withOrg(org.orgId, () => postDocument(creditId, postingDeps(org)))
    await withOrg(org.orgId, () => db.transaction((tx) => completeReturnInspection(tx, org.orgId, actorId, rma.id, null)))
    const header = (await db.execute<{ total: string }>(sql`
      select total::text from documents where org_id = ${org.orgId} and id = ${creditId}`)).rows[0]
    assert.equal(header?.total, '90.0000')
    const unbalanced = (await db.execute(sql`
      select entry_id from journal_lines where org_id = ${org.orgId} group by entry_id having sum(amount) <> 0`)).rows
    assert.equal(unbalanced.length, 0)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
