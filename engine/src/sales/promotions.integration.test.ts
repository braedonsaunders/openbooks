import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { toUnits } from '../money/money.ts'
import { db, withBypassContext, withOrg } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '../testing/fixtures.ts'
import {
  applyPromotion,
  createPromotion,
  listPromotions,
  PromotionRefusal,
  setPromotionStatus,
} from './promotions.ts'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

async function enablePromotions(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"promotions": true}'::jsonb) where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1)
}

async function draftSale(org: ScratchOrg, lines: { itemId: string; quantity: string; unitPrice: string; amount: string }[]): Promise<string> {
  const documentId = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', '0', '0', '0', '{}'::jsonb)`)
  let number = 1
  for (const line of lines) {
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed, custom, tax_overridden)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${number}, ${line.itemId}, ${org.accounts.revenue},
              ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0', false, '0', '0', '{}'::jsonb, false)`)
    number += 1
  }
  return documentId
}

async function discountLines(orgId: string, documentId: string) {
  return (await db.execute<{ amount: string; promotion_id: string | null; account_id: string }>(sql`
    select amount::text, promotion_id, account_id from document_lines
     where org_id = ${orgId} and document_id = ${documentId} and promotion_id is not null
     order by line_number`)).rows
}

async function usageCount(orgId: string, promotionId: string): Promise<number> {
  const row = (await db.execute<{ usage_count: number }>(sql`
    select usage_count from promotions where org_id = ${orgId} and id = ${promotionId}`)).rows[0]
  assert.ok(row)
  return row.usage_count
}

test('percent promotion discounts every eligible line and sums exactly', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePromotions(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const promotion = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
      code: 'SAVE15', name: 'Autumn fifteen', kind: 'percent', percentValue: '15',
      discountAccountId: org.accounts.revenue,
    })))
    const active = await withOrg(org.orgId, () => db.transaction((tx) => setPromotionStatus(tx, org.orgId, actorId, promotion.id, 'active')))
    assert.equal(active.status, 'active')
    // Two different line values: exact 15% shares are 0.0150 and 0.0300, so
    // the penny must land on exactly one line for the total to stay 0.05.
    const documentId = await withOrg(org.orgId, () => draftSale(org, [
      { itemId: org.items.fifo, quantity: '1', unitPrice: '0.10', amount: '0.10' },
      { itemId: org.items.service, quantity: '1', unitPrice: '0.20', amount: '0.20' },
    ]))
    const applied = await withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
      documentId, code: 'save15', allowedSubsidiaryIds: null,
    })))
    assert.equal(applied.discountMinor, '5')
    assert.equal(applied.lines.length, 2)
    const stored = await withOrg(org.orgId, () => discountLines(org.orgId, documentId))
    assert.equal(stored.length, 2)
    const minors = stored.map((line) => toUnits(line.amount) / 100n)
    assert.deepEqual(minors, [-2n, -3n])
    assert.ok(stored.every((line) => line.promotion_id === promotion.id))
    assert.equal(await withOrg(org.orgId, () => usageCount(org.orgId, promotion.id)), 1)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('usage limit holds under concurrent application', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePromotions(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const promotion = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
      code: 'ONCE', name: 'Single use', kind: 'amount', amountMinor: 500n, currency: 'CAD',
      usageLimit: 1, discountAccountId: org.accounts.revenue,
    })))
    await withOrg(org.orgId, () => db.transaction((tx) => setPromotionStatus(tx, org.orgId, actorId, promotion.id, 'active')))
    const first = await withOrg(org.orgId, () => draftSale(org, [
      { itemId: org.items.fifo, quantity: '1', unitPrice: '10', amount: '10' },
    ]))
    const second = await withOrg(org.orgId, () => draftSale(org, [
      { itemId: org.items.fifo, quantity: '1', unitPrice: '10', amount: '10' },
    ]))
    const outcomes = await withBypassContext(() => Promise.allSettled([
      withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId: first, code: 'ONCE', allowedSubsidiaryIds: null,
      }))),
      withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId: second, code: 'ONCE', allowedSubsidiaryIds: null,
      }))),
    ]))
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    const refusal = (rejected[0] as PromiseRejectedResult).reason
    assert.ok(refusal instanceof PromotionRefusal && refusal.code === 'limit_reached' && refusal.status === 409)
    assert.ok(refusal.message.includes('ONCE') && refusal.message.includes('1'))
    assert.equal(await withOrg(org.orgId, () => usageCount(org.orgId, promotion.id)), 1)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('window refusals name the promotion dates', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePromotions(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    // Two campaigns that miss today on opposite sides: the messages must
    // tell them apart by naming the side that failed.
    const ended = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
      code: 'WINTER', name: 'Winter sale', kind: 'percent', percentValue: '10',
      startsAt: '2000-01-01T00:00:00Z', endsAt: '2000-02-01T00:00:00Z',
      discountAccountId: org.accounts.revenue,
    })))
    const upcoming = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
      code: 'SPRING', name: 'Spring sale', kind: 'percent', percentValue: '10',
      startsAt: '2999-03-01T00:00:00Z', endsAt: '2999-04-01T00:00:00Z',
      discountAccountId: org.accounts.revenue,
    })))
    for (const id of [ended.id, upcoming.id]) {
      await withOrg(org.orgId, () => db.transaction((tx) => setPromotionStatus(tx, org.orgId, actorId, id, 'active')))
    }
    const listed = await withOrg(org.orgId, () => listPromotions(db, org.orgId, true))
    assert.equal(listed.length, 2)
    const documentId = await withOrg(org.orgId, () => draftSale(org, [
      { itemId: org.items.fifo, quantity: '1', unitPrice: '10', amount: '10' },
    ]))
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId, code: 'winter', allowedSubsidiaryIds: null,
      }))),
      (error: unknown) => error instanceof PromotionRefusal && error.code === 'expired'
        && /2000-02-01/.test(error.message) && !/2000-01-01/.test(error.message),
    )
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId, code: 'SPRING', allowedSubsidiaryIds: null,
      }))),
      (error: unknown) => error instanceof PromotionRefusal && error.code === 'not_started'
        && /2999-03-01/.test(error.message) && !/2999-04-01/.test(error.message),
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('channel-scoped promotion refuses the wrong channel', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePromotions(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    const scoped = randomUUID()
    const promotion = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
      code: 'WEB10', name: 'Web store ten', kind: 'percent', percentValue: '10',
      channelScopeId: scoped, discountAccountId: org.accounts.revenue,
    })))
    await withOrg(org.orgId, () => db.transaction((tx) => setPromotionStatus(tx, org.orgId, actorId, promotion.id, 'active')))
    const documentId = await withOrg(org.orgId, () => draftSale(org, [
      { itemId: org.items.fifo, quantity: '1', unitPrice: '10', amount: '10' },
    ]))
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId, code: 'WEB10', channelId: randomUUID(), allowedSubsidiaryIds: null,
      }))),
      (error: unknown) => error instanceof PromotionRefusal && error.code === 'wrong_channel' && error.status === 409
        && /WEB10/.test(error.message) && /channel/.test(error.remedy ?? ''),
    )
    const applied = await withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
      documentId, code: 'WEB10', channelId: scoped, allowedSubsidiaryIds: null,
    })))
    assert.equal(applied.discountMinor, '100')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('buy X get Y frees units only from complete buy-plus-get groups', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await enablePromotions(org.orgId)
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    for (const [code, buyQuantity, getQuantity] of [['BOGO', 1, 1], ['B2G1', 2, 1]] as const) {
      const promotion = await withOrg(org.orgId, () => db.transaction((tx) => createPromotion(tx, org.orgId, actorId, {
        code, name: code, kind: 'buy_x_get_y', buyQuantity, getQuantity, discountAccountId: org.accounts.revenue,
      })))
      await withOrg(org.orgId, () => db.transaction((tx) => setPromotionStatus(tx, org.orgId, actorId, promotion.id, 'active')))
    }
    const apply = async (code: string, quantity: string) => {
      const documentId = await withOrg(org.orgId, () => draftSale(org, [
        { itemId: org.items.fifo, quantity, unitPrice: '10', amount: String(BigInt(quantity) * 10n) },
      ]))
      return withOrg(org.orgId, () => db.transaction((tx) => applyPromotion(tx, org.orgId, actorId, {
        documentId, code, allowedSubsidiaryIds: null,
      })))
    }
    // One unit is the qualifying purchase itself: nothing is free yet.
    await assert.rejects(apply('BOGO', '1'), (error: unknown) => error instanceof PromotionRefusal
      && error.code === 'below_threshold' && /BOGO needs at least 2 units/.test(error.message) && /2 or more/.test(error.remedy ?? ''))
    for (const [quantity, freeMinor] of [['2', '1000'], ['3', '1000'], ['4', '2000']]) {
      assert.equal((await apply('BOGO', quantity)).discountMinor, freeMinor, `buy 1 get 1 on ${quantity} units`)
    }
    assert.equal((await apply('B2G1', '3')).discountMinor, '1000')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
