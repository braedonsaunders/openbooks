import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgTransaction } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from '../testing/fixtures.ts'
import { prorate } from '../billing/subscription-billing.ts'
import { createPromotion, setPromotionStatus } from '../sales/promotions.ts'
import { PortalRefusal } from './errors.ts'
import { consumePortalLink, requestPortalLink } from './tokens.ts'
import { savePortalSettings } from './settings.ts'
import { portalHome } from './workspace.ts'
import {
  acceptSaveOffer,
  applySubscriptionChange,
  cancelSubscription,
  pauseSubscription,
  previewSubscriptionChange,
  resumeSubscription,
  validatePortalReturn,
} from './changes.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const EMAIL = 'portal-customer@example.com'
const PERIOD_START = '2026-07-01'
const PERIOD_END = '2026-08-01'
const AS_OF = '2026-07-15'

test('portal order amounts retain registry precision and customer isolation', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const channelId = randomUUID()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('USD', 'US Dollar', 2), ('BHD', 'Bahraini Dinar', 3), ('JPY', 'Japanese Yen', 0)
        -- Existing seeded currencies retain their authoritative registry values.
        on conflict (code) do nothing`)
      assert.equal((await db.execute(sql`select code from currencies where code = 'RHD'`)).rows.length, 0,
        'the legacy-code fixture must lack a precision entry')
      await db.execute(sql`
        insert into sales_channels (id, org_id, kind, name, subsidiary_id, currency, external_account)
        values (${channelId}, ${org.orgId}, 'shopify', 'Customer orders', ${org.subsidiaryId}, 'USD', ${channelId})`)
      for (const [currency, total] of [['USD', '12345'], ['BHD', '1234'], ['JPY', '1234'], ['RHD', '12345']] as const) {
        await db.execute(sql`
          insert into channel_orders (org_id, channel_id, external_id, external_number, customer_party_id,
            shop_currency, presentment_currency, subtotal_minor, tax_minor, shipping_minor, total_minor, ordered_at)
          values (${org.orgId}, ${channelId}, ${currency}, ${`WEB-${currency}`}, ${org.customerId},
            ${currency}, ${currency}, ${total}, 0, 0, ${total}, '2026-10-05T10:00:00Z')`)
      }
    })
    const home = await withOrgTransaction(org.orgId, (tx) => portalHome(org.orgId, org.customerId, tx))
    const orders = new Map(home.orders.map((order) => [order.currency, order]))
    assert.equal(orders.size, 4)
    for (const [currency, total, precision] of [['USD', '12345', 2], ['BHD', '1234', 3], ['JPY', '1234', 0], ['RHD', '12345', null]] as const) {
      assert.equal(orders.get(currency)?.totalMinor, total, `${currency} storage units remain unchanged`)
      assert.equal(orders.get(currency)?.minorUnits, precision, `${currency} uses registry precision or explicit unknown`)
    }
    const other = await withOrgTransaction(org.orgId, (tx) => portalHome(org.orgId, org.vendorId, tx))
    assert.deepEqual(other.orders, [], 'another customer cannot read the order amounts')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

async function enableFeatures(orgId: string, features: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || ${features}::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function seedSubscription(org: ScratchOrg): Promise<{ subscriptionId: string; linkId: string }> {
  await enableFeatures(org.orgId, '{"customerPortal": true, "subscriptionBilling": true}')
  await withBypassContext(() => db.execute(sql`
    update parties set email = ${EMAIL} where id = ${org.customerId} and org_id = ${org.orgId}`))
  const planId = randomUUID()
  const subscriptionId = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into subscription_plans (id, org_id, name, amount, interval, interval_count, income_account_id)
    values (${planId}, ${org.orgId}, 'Portal plan', '100.0000', 'monthly', 1, ${org.accounts.revenue})`))
  await withBypassContext(() => db.execute(sql`
    insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, current_period_start, next_bill_on, auto_post)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active', ${PERIOD_START}, ${PERIOD_START}, ${PERIOD_END}, false)`))
  const session = await consumePortalLink((await requestPortalLink(EMAIL)).links[0]!.token)
  assert.equal(session.partyId, org.customerId)
  return { subscriptionId, linkId: session.linkId }
}

test('proration preview equals the engine amendment', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { subscriptionId, linkId } = await seedSubscription(org)
    const preview = await previewSubscriptionChange(org.orgId, org.customerId, {
      subscriptionId, quantity: '2', effectiveOn: AS_OF,
    })
    const expectedSlice = prorate('100.0000', PERIOD_START, PERIOD_END, AS_OF)
    assert.equal(preview.adjustment, expectedSlice)
    assert.equal(preview.documentKind, 'customer_invoice')
    const applied = await applySubscriptionChange(org.orgId, org.customerId, linkId, {
      subscriptionId, quantity: '2', effectiveOn: AS_OF,
    })
    assert.equal(applied.adjustment, preview.adjustment)
    assert.ok(applied.invoiceId)
    const invoice = (await withBypassContext(() => db.execute<{ kind: string; subtotal: string }>(sql`
      select kind, subtotal::text as subtotal from documents where id = ${applied.invoiceId} and org_id = ${org.orgId}`))).rows[0]!
    assert.equal(invoice.kind, 'customer_invoice')
    assert.equal(invoice.subtotal, expectedSlice)
    const downgrade = await applySubscriptionChange(org.orgId, org.customerId, linkId, {
      subscriptionId, quantity: '1', effectiveOn: AS_OF,
    })
    assert.equal(downgrade.adjustment, `-${expectedSlice}`)
    const credit = (await withBypassContext(() => db.execute<{ kind: string }>(sql`
      select kind from documents where id = ${downgrade.invoiceId} and org_id = ${org.orgId}`))).rows[0]!
    assert.equal(credit.kind, 'customer_credit')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('pause, resume and cancel guard the subscription lifecycle', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { subscriptionId, linkId } = await seedSubscription(org)
    assert.deepEqual(await pauseSubscription(org.orgId, org.customerId, linkId, subscriptionId), { status: 'paused' })
    await assert.rejects(pauseSubscription(org.orgId, org.customerId, linkId, subscriptionId),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'wrong_state')
    assert.deepEqual(await resumeSubscription(org.orgId, org.customerId, linkId, subscriptionId), { status: 'active' })
    await assert.rejects(cancelSubscription(org.orgId, org.customerId, linkId, subscriptionId, '  '),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'invalid_input')
    await cancelSubscription(org.orgId, org.customerId, linkId, subscriptionId, 'Too expensive')
    const events = (await withBypassContext(() => db.execute<{ action: string; detail: unknown }>(sql`
      select action, detail from customer_portal_events where org_id = ${org.orgId} and party_id = ${org.customerId}
       order by created_at`))).rows
    const canceled = events.find((event) => event.action === 'subscription_canceled')
    assert.ok(canceled)
    assert.match(JSON.stringify(canceled.detail), /Too expensive/)
    await assert.rejects(
      previewSubscriptionChange(org.orgId, org.customerId, { subscriptionId, quantity: '2' }),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'wrong_state',
    )
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

async function seedDraftInvoice(org: ScratchOrg, status = 'draft'): Promise<string> {
  const documentId = randomUUID()
  const lineId = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           currency, status, subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, 'CAD', ${status}, '200', '0', '200', '{}'::jsonb)`))
  await withBypassContext(() => db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                amount, tax_amount, stock_location_id, custom)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue},
            '2', '100', '200', '0', ${org.stockLocationId}, '{}'::jsonb)`))
  return documentId
}

test('cancel save offer applies the promotion to the open draft', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const { subscriptionId, linkId } = await seedSubscription(org)
    await enableFeatures(org.orgId, '{"promotions": true}')
    const actor = org.customerId
    const promotion = await withOrgTransaction(org.orgId, async () =>
      createPromotion(db, org.orgId, actor, {
        code: 'SAVE20', name: 'Save 20', kind: 'percent', percentValue: '20', discountAccountId: org.accounts.revenue,
      }))
    await withOrgTransaction(org.orgId, async () => setPromotionStatus(db, org.orgId, actor, promotion.id, 'active'))
    await withBypassContext(() => savePortalSettings(org.orgId, actor, {
      saveOffers: [{ id: 'keep-20', kind: 'discount', label: 'Stay for 20% off', promotionCode: 'SAVE20' }],
    }))
    await assert.rejects(acceptSaveOffer(org.orgId, org.customerId, linkId, { subscriptionId, offerId: 'keep-20' }),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'no_draft_invoice' && error.status === 409)
    const draftId = await seedDraftInvoice(org)
    const accepted = await acceptSaveOffer(org.orgId, org.customerId, linkId, { subscriptionId, offerId: 'keep-20' })
    assert.equal(accepted.kind, 'discount')
    assert.equal(accepted.promotionCode, 'SAVE20')
    assert.ok(BigInt(accepted.discountMinor!) > 0n)
    const discountLines = (await withBypassContext(() => db.execute<{ promotion_id: string; amount: string }>(sql`
      select promotion_id, amount::text as amount from document_lines
       where org_id = ${org.orgId} and document_id = ${draftId} and promotion_id is not null`))).rows
    assert.equal(discountLines.length, 1)
    assert.equal(discountLines[0]!.promotion_id, promotion.id)
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

async function seedSourceInvoice(org: ScratchOrg, documentDate: string, number: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           currency, status, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'customer_invoice', ${number}, ${org.customerId}, ${org.subsidiaryId},
            ${documentDate}, 'CAD', 'draft', '100', '0', '100', '{}'::jsonb)`))
  return id
}

test('portal returns validate the window, reasons and outcomes by name', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enableFeatures(org.orgId, '{"customerPortal": true, "returnAuthorizations": true}')
    await withBypassContext(() => db.execute(sql`
      update parties set email = ${EMAIL} where id = ${org.customerId} and org_id = ${org.orgId}`))
    const actor = org.customerId
    await withBypassContext(() => savePortalSettings(org.orgId, actor, {
      returnWindowDays: 30,
      returnReasons: ['damaged', 'wrong_item'],
      returnResolutions: { refund: true, exchange: false, storeCredit: true, storeCreditBonusPercent: '10' },
    }))
    const oldId = await seedSourceInvoice(org, '2025-01-01', 'INV-OLD-001')
    await assert.rejects(
      validatePortalReturn(org.orgId, org.customerId, {
        sourceDocumentId: oldId, reasonCode: 'damaged', resolution: 'refund',
        lines: [{ sourceIssueMovementId: randomUUID(), quantity: '1' }],
      }),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'outside_return_window'
        && /30-day return window/.test(error.message) && /contact your supplier/i.test(error.remedy ?? ''),
    )
    const today = new Date().toISOString().slice(0, 10)
    const freshId = await seedSourceInvoice(org, today, 'INV-NEW-001')
    await assert.rejects(
      validatePortalReturn(org.orgId, org.customerId, {
        sourceDocumentId: freshId, reasonCode: 'changed_mind', resolution: 'refund',
        lines: [{ sourceIssueMovementId: randomUUID(), quantity: '1' }],
      }),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'return_reason_not_allowed'
        && /damaged, wrong_item/.test(error.message),
    )
    await assert.rejects(
      validatePortalReturn(org.orgId, org.customerId, {
        sourceDocumentId: freshId, reasonCode: 'damaged', resolution: 'exchange',
        lines: [{ sourceIssueMovementId: randomUUID(), quantity: '1' }],
      }),
      (error: unknown) => error instanceof PortalRefusal && error.code === 'return_resolution_not_allowed',
    )
    const validated = await validatePortalReturn(org.orgId, org.customerId, {
      sourceDocumentId: freshId, reasonCode: 'damaged', resolution: 'store_credit',
      lines: [{ sourceIssueMovementId: randomUUID(), quantity: '2' }],
    })
    assert.equal(validated.sourceDocumentId, freshId)
    assert.equal(validated.reasonCode, 'damaged')
    assert.equal(validated.resolution, 'store_credit')
    assert.equal(validated.storeCreditBonusPercent, '10')
    assert.equal(validated.lines.length, 1)
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})
