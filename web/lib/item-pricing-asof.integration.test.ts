import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemPrice } = await import('./item-pricing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * PRC15: Gold is assigned January 1 with a January Gold price of $100; the
 * admin deactivates the Gold assignment in March. A legitimate late January
 * 15 transaction must still price at the Gold price in force that day —
 * membership is the effective-dated window, never current activation — while
 * current dates price off the live hierarchy.
 */
test('a late January entry prices Gold after the assignment is deactivated', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const customerId = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${customerId}, true)`)
      const goldId = randomUUID()
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD', 'Gold price', 'explicit', false, true)`)
      const baseId = (await db.execute<{ id: string }>(sql`
        select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
      await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
        values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
      const goldSchedule = randomUUID()
      const baseSchedule = randomUUID()
      await db.execute(sql`insert into item_price_schedules
          (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
        values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', '2026-01-31', true),
               (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
      for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
        await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
          values (${org.orgId}, ${schedule}, '1', ${price})`)
      }

      const input = {
        orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
      } as const
      const january = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
      assert.equal(january?.unitPrice, '100.0000')
      assert.equal(january?.source, 'customer_level')

      // March: the admin deactivates the Gold assignment. End-dated
      // membership keeps January covered instead of flipping a flag.
      await db.execute(sql`update customer_price_level_assignments set is_active = false
       where org_id = ${org.orgId} and customer_id = ${customerId}`)
      const membership = (await db.execute<{ is_active: boolean; effective_to: string | null }>(sql`
        select is_active, effective_to::text as effective_to from customer_price_level_assignments
         where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
      assert.equal(membership.is_active, false)
      assert.ok(membership.effective_to !== null && membership.effective_to < '2026-01-15' === false,
        `deactivation must end-date, not erase, the window (got ${membership.effective_to})`)

      const late = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
      assert.equal(late?.unitPrice, '100.0000')
      assert.equal(late?.source, 'customer_level')

      // Current dates follow the live hierarchy: no Gold membership, so the
      // base price — never a resurrected assignment.
      const today = new Date().toISOString().slice(0, 10)
      const now = await resolveItemPrice({ ...input, onDate: today })
      assert.equal(now?.unitPrice, '80.0000')
      assert.equal(now?.source, 'base_level')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

/**
 * PRC15b: the customer's assignment stays effective but the LEVEL is
 * deactivated, so no joined level row survives the activation predicate and
 * the Gold price must not win for dates when Gold is dark — the base price
 * applies instead, while dates inside the level's active window still read
 * Gold. Fixture shape is pre-0244 legacy (the level guard refuses new
 * writes of this shape, so it is disabled for the single statement that
 * builds the legacy row, then re-enabled): an effective assignment plus an
 * active schedule on a dead level.
 */
test('a deactivated level stops pricing while the assignment stays effective', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const customerId = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${customerId}, true)`)
      const goldId = randomUUID()
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD3', 'Gold price', 'explicit', false, true)`)
      const baseId = (await db.execute<{ id: string }>(sql`
        select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
      await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
        values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
      const goldSchedule = randomUUID()
      const baseSchedule = randomUUID()
      await db.execute(sql`insert into item_price_schedules
          (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
        values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
               (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
      for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
        await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
          values (${org.orgId}, ${schedule}, '1', ${price})`)
      }

      const input = {
        orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
      } as const
      const january = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
      assert.equal(january?.unitPrice, '100.0000')
      assert.equal(january?.source, 'customer_level')

      // Legacy shape: the level dies while the assignment and its schedule
      // stay live. The guard is re-enabled immediately afterwards.
      await db.execute(sql`alter table price_levels disable trigger price_level_base_guard`)
      try {
        await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
      } finally {
        await db.execute(sql`alter table price_levels enable trigger price_level_base_guard`)
      }
      const assignment = (await db.execute<{ is_active: boolean; effective_to: string | null }>(sql`
        select is_active, effective_to::text as effective_to from customer_price_level_assignments
         where org_id = ${org.orgId} and customer_id = ${customerId}`)).rows[0]!
      assert.equal(assignment.is_active, true)
      assert.equal(assignment.effective_to, null)

      // Today the level is dark: the base price, never the dead Gold price.
      const today = new Date().toISOString().slice(0, 10)
      const now = await resolveItemPrice({ ...input, onDate: today })
      assert.equal(now?.unitPrice, '80.0000')
      assert.equal(now?.source, 'base_level')

      // History preserved: January was inside the level's active window.
      const late = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
      assert.equal(late?.unitPrice, '100.0000')
      assert.equal(late?.source, 'customer_level')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

/**
 * PRC15b historical window: the level died and was later reactivated, so a
 * past date in the dark gap prices base while dates on either side of the
 * gap still read the Gold price that was offered then.
 */
test('a historical inactive gap prices base while both active windows price Gold', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const customerId = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${customerId}, ${org.orgId}, 'customer', 'Gold Customer', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${customerId}, true)`)
      const goldId = randomUUID()
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD4', 'Gold price', 'explicit', false, true)`)
      const baseId = (await db.execute<{ id: string }>(sql`
        select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!.id
      await db.execute(sql`insert into customer_price_level_assignments (org_id, customer_id, price_level_id, effective_from, is_active)
        values (${org.orgId}, ${customerId}, ${goldId}, '2026-01-01', true)`)
      const goldSchedule = randomUUID()
      const baseSchedule = randomUUID()
      await db.execute(sql`insert into item_price_schedules
          (id, org_id, item_id, price_level_id, currency, quantity_basis, effective_from, effective_to, is_active)
        values (${goldSchedule}, ${org.orgId}, ${org.items.service}, ${goldId}, 'CAD', 'line_quantity', '2026-01-01', null, true),
               (${baseSchedule}, ${org.orgId}, ${org.items.service}, ${baseId}, 'CAD', 'line_quantity', '2026-01-01', null, true)`)
      for (const [schedule, price] of [[goldSchedule, '100'], [baseSchedule, '80']] as const) {
        await db.execute(sql`insert into item_price_breaks (org_id, schedule_id, minimum_quantity, unit_price)
          values (${org.orgId}, ${schedule}, '1', ${price})`)
      }

      const input = {
        orgId: org.orgId, itemId: org.items.service, customerId, currency: 'CAD', lineQuantity: '1',
      } as const
      // Legacy deactivation, then a reactivation; the history rows are then
      // shaped into a March-to-June dark gap (the resolver's source of truth
      // for past dates is the history table, however its rows arose).
      await db.execute(sql`alter table price_levels disable trigger price_level_base_guard`)
      try {
        await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
      } finally {
        await db.execute(sql`alter table price_levels enable trigger price_level_base_guard`)
      }
      await db.execute(sql`update price_levels set is_active = true where org_id = ${org.orgId} and id = ${goldId}`)
      await db.execute(sql`update price_level_activation_history set active_to = '2026-03-01'
        where org_id = ${org.orgId} and price_level_id = ${goldId} and active_to is not null`)
      await db.execute(sql`update price_level_activation_history set active_from = '2026-06-01'
        where org_id = ${org.orgId} and price_level_id = ${goldId} and active_to is null`)

      const gap = await resolveItemPrice({ ...input, onDate: '2026-04-15' })
      assert.equal(gap?.unitPrice, '80.0000')
      assert.equal(gap?.source, 'base_level')

      const before = await resolveItemPrice({ ...input, onDate: '2026-01-15' })
      assert.equal(before?.unitPrice, '100.0000')
      assert.equal(before?.source, 'customer_level')

      const today = new Date().toISOString().slice(0, 10)
      const now = await resolveItemPrice({ ...input, onDate: today })
      assert.equal(now?.unitPrice, '100.0000')
      assert.equal(now?.source, 'customer_level')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

/**
 * Level activation is versioned (0327): deactivating the level closes its
 * period, so past dates still read it as offered while today does not — and
 * a level created today never covered last month.
 */
test('deactivating a price level closes its history period without rewriting the past', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const goldId = randomUUID()
      await db.execute(sql`insert into price_levels (id, org_id, code, name, pricing_method, is_base, is_active)
        values (${goldId}, ${org.orgId}, 'GOLD2', 'Gold price', 'explicit', false, true)`)
      const opened = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
        select active_from::text as active_from, active_to::text as active_to
          from price_level_activation_history where org_id = ${org.orgId} and price_level_id = ${goldId}`)).rows
      assert.equal(opened.length, 1)
      // Standing offer: creation never ends coverage of backdated schedules.
      assert.equal(opened[0]!.active_from, '-infinity')
      assert.equal(opened[0]!.active_to, null)

      await db.execute(sql`update price_levels set is_active = false where org_id = ${org.orgId} and id = ${goldId}`)
      const closed = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
        select active_from::text as active_from, active_to::text as active_to
          from price_level_activation_history where org_id = ${org.orgId} and price_level_id = ${goldId}`)).rows
      assert.equal(closed.length, 1)
      const today = new Date().toISOString().slice(0, 10)
      assert.equal(closed[0]!.active_to, today)

      // Reactivation opens a new period; the dark gap stays dark.
      await db.execute(sql`update price_levels set is_active = true where org_id = ${org.orgId} and id = ${goldId}`)
      const periods = (await db.execute<{ active_from: string; active_to: string | null }>(sql`
        select active_from::text as active_from, active_to::text as active_to
          from price_level_activation_history
         where org_id = ${org.orgId} and price_level_id = ${goldId} order by active_from`)).rows
      assert.equal(periods.length, 2)
      assert.equal(periods[1]!.active_from, today)
      assert.equal(periods[1]!.active_to, null)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
