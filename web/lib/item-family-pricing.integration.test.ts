import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createItemFamily, generateFamilyVariants } = await import('@openbooks/engine/src/inventory/item-families.ts')
const { resolveItemPrice } = await import('./item-pricing.ts')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

interface Fixture {
  orgId: string
  currency: string
  onDate: string
  customerId: string
  wholesaleId: string
  baseId: string
  familyId: string
  variantId: string
  serviceId: string
}

async function seed(): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    const actorId = (await seedFlowActors(org.orgId)).adminId
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":true}'::jsonb)
       where id = ${org.orgId}`)
    const currency = (await db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${org.orgId}`)).rows[0]!.base_currency
    const customerId = randomUUID()
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${customerId}, ${org.orgId}, 'customer', 'Tee Buyer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${customerId}, true)`)
    const wholesaleId = randomUUID()
    await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
      values (${wholesaleId}, ${org.orgId}, 'WHOLESALE', 'Wholesale', 'explicit', false, true)`)
    const baseId = (await db.execute<{ id: string }>(sql`select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
    const onDate = new Date().toISOString().slice(0, 10)
    await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
      values (${org.orgId}, ${customerId}, ${wholesaleId}, '2020-01-01', true)`)
    const family = await createItemFamily(org.orgId, actorId, {
      code: 'TEE',
      name: 'Classic Tee',
      kind: 'inventory',
      defaultUnit: 'each',
      defaultRate: '24.99',
      options: [{ name: 'Size', values: ['S', 'M'] }],
    })
    const generated = await generateFamilyVariants(org.orgId, actorId, family.id)
    const variantId = generated.variants[0]!.id
    return { orgId: org.orgId, currency, onDate, customerId, wholesaleId, baseId, familyId: family.id, variantId, serviceId: org.items.service }
  })
}

async function addSchedule(fixture: Fixture, spec: {
  itemId?: string | null
  familyId?: string | null
  priceLevelId?: string | null
  customerId?: string | null
  price?: string
  from?: string
  to?: string | null
}) {
  return withBypassContext(async () => {
    const row = (await db.execute<{ id: string }>(sql`
      insert into item_price_schedules
        (org_id, item_id, family_id, price_level_id, customer_id, currency, quantity_basis, effective_from, effective_to, is_active)
      values
        (${fixture.orgId}, ${spec.itemId ?? null}, ${spec.familyId ?? null}, ${spec.priceLevelId ?? null}, ${spec.customerId ?? null},
         ${fixture.currency}, 'line_quantity', ${spec.from ?? '2020-01-01'}::date, ${spec.to ?? null}::date, true)
      returning id`)).rows[0]!
    await db.execute(sql`
      insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
      values (${fixture.orgId}, ${row.id}, 1, ${spec.price ?? '10.0000'})`)
    return row.id
  })
}

async function priceOf(fixture: Fixture, variantId: string, customerId: string | null = null) {
  return resolveItemPrice({
    orgId: fixture.orgId,
    itemId: variantId,
    customerId,
    currency: fixture.currency,
    lineQuantity: '1',
    onDate: fixture.onDate,
  })
}

test('a variant with no schedule inherits the family base-level price', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '20.0000' })
    const price = await priceOf(fixture, fixture.variantId)
    assert.equal(price?.unitPrice, '20.0000')
    assert.equal(price?.source, 'family_base_level')
    assert.equal(price?.familyId, fixture.familyId)
    assert.equal(price?.familyName, 'Classic Tee')
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('a variant override wins over the family schedule', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '20.0000' })
    await addSchedule(fixture, { itemId: fixture.variantId, priceLevelId: fixture.baseId, price: '22.0000' })
    const price = await priceOf(fixture, fixture.variantId)
    assert.equal(price?.unitPrice, '22.0000')
    assert.equal(price?.source, 'base_level')
    assert.equal(price?.familyId, null)
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('a customer family schedule beats the variant level price', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { itemId: fixture.variantId, priceLevelId: fixture.wholesaleId, price: '18.0000' })
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.wholesaleId, price: '19.0000' })
    await addSchedule(fixture, { familyId: fixture.familyId, customerId: fixture.customerId, price: '17.0000' })
    const price = await priceOf(fixture, fixture.variantId, fixture.customerId)
    assert.equal(price?.unitPrice, '17.0000')
    assert.equal(price?.source, 'customer_family')
    assert.equal(price?.familyCode, 'TEE')
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('a customer variant schedule wins over every family price', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { familyId: fixture.familyId, customerId: fixture.customerId, price: '17.0000' })
    await addSchedule(fixture, { itemId: fixture.variantId, customerId: fixture.customerId, price: '16.0000' })
    const price = await priceOf(fixture, fixture.variantId, fixture.customerId)
    assert.equal(price?.unitPrice, '16.0000')
    assert.equal(price?.source, 'customer_item')
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('an ended family schedule falls back to the family base price', enabled, async () => {
  const fixture = await seed()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update items set default_rate = null where org_id = ${fixture.orgId} and id = ${fixture.variantId}`)
    })
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '20.0000', from: '2020-01-01', to: '2020-12-31' })
    const price = await priceOf(fixture, fixture.variantId)
    assert.equal(price?.unitPrice, '24.9900')
    assert.equal(price?.source, 'family_base')
    assert.equal(price?.familyName, 'Classic Tee')
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('a standalone item resolves exactly as before the family change', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '20.0000' })
    await addSchedule(fixture, { itemId: fixture.serviceId, priceLevelId: fixture.baseId, price: '30.0000' })
    const price = await priceOf(fixture, fixture.serviceId)
    assert.equal(price?.unitPrice, '30.0000')
    assert.equal(price?.source, 'base_level')
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

test('overlapping family schedules are refused at both scopes', enabled, async () => {
  const fixture = await seed()
  try {
    await addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '20.0000' })
    await rejectsWith(
      () => addSchedule(fixture, { familyId: fixture.familyId, priceLevelId: fixture.baseId, price: '21.0000' }),
      /23P01/,
    )
    await addSchedule(fixture, { familyId: fixture.familyId, customerId: fixture.customerId, price: '17.0000' })
    await rejectsWith(
      () => addSchedule(fixture, { familyId: fixture.familyId, customerId: fixture.customerId, price: '17.5000' }),
      /23P01/,
    )
    await rejectsWith(
      () => withBypassContext(async () => {
        await db.execute(sql`
          insert into item_price_schedules (org_id, item_id, family_id, price_level_id, currency, effective_from, is_active)
          values (${fixture.orgId}, ${fixture.variantId}, ${fixture.familyId}, ${fixture.baseId}, ${fixture.currency}, '2020-01-01', true)`)
      }),
      /item_price_schedule_subject/,
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId))
  }
})

/**
 * The driver wraps failures: the SQLSTATE and the constraint name live on
 * the cause, not on the outer message. Match against both so a refusal that
 * names the wrong guard cannot pass.
 */
async function rejectsWith(operation: () => Promise<unknown>, match: RegExp): Promise<void> {
  const error = await operation().then(
    () => null,
    (failure: unknown) => failure as { message?: string; code?: string; cause?: { message?: string; code?: string } },
  )
  assert.ok(error, 'expected the write to be refused')
  const cause = error.cause ?? {}
  assert.match(`${error.message ?? ''} ${error.code ?? ''} ${cause.message ?? ''} ${cause.code ?? ''}`, match)
}
