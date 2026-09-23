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
const { resolveItemRate } = await import('./item-rates')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * PRC1: the pricing policy is current state, but rate lines are
 * effective-dated. Switching the policy for next month must not reprice a
 * late entry dated in the old month: resolution reads the SELECTED version's
 * pinned policy, base unit and presentation — never the live profile.
 *
 * Tiers 1/$10, 4/$30, 6/$50 price 8 units at $70 under capped_ladder and at
 * $60 (two 4-packs) under lowest_cost. The profile holds the NEW policy
 * (lowest_cost); the January version pins the OLD one (capped_ladder).
 */
test('a late entry in the old month prices under the old pinned policy', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const project = randomUUID(), book = randomUUID(), v1 = randomUUID(), v2 = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PINNED', 'Pinned policy job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'PINNED-RATES', 'Pinned rates book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
        values (${org.orgId}, ${book}, 'usage_date', true)`)
      // The live profile already carries the NEW month's policy.
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components', true)`)
      for (const [version, from, to] of [[v1, '2026-01-01', '2026-01-31'], [v2, '2026-02-01', null]] as const) {
        await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status, custom)
          values (${version}, ${org.orgId}, ${book}, ${from}, ${to}, 'draft', '{}'::jsonb)`)
        await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
          values (${org.orgId}, ${version}, ${org.items.service}, 'one', 'One', 1, 10, 10),
                 (${org.orgId}, ${version}, ${org.items.service}, 'four', 'Four', 4, 30, 30),
                 (${org.orgId}, ${version}, ${org.items.service}, 'six', 'Six', 6, 50, 50)`)
      }
      // Each version pins what was in force when it was saved.
      await db.execute(sql`insert into item_rate_version_profiles (org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
        values (${org.orgId}, ${v1}, ${org.items.service}, 'day', 'capped_ladder', 'summary'),
               (${org.orgId}, ${v2}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components')`)
      await db.execute(sql`update item_rate_versions set status = 'active' where org_id = ${org.orgId} and rate_book_id = ${book}`)

      const january = await resolveItemRate({
        orgId: org.orgId, projectId: project, itemId: org.items.service,
        onDate: '2026-01-15', baseQuantity: '8',
      })
      assert.equal(january?.bill.amount, '70.0000')
      assert.equal(january?.policy, 'capped_ladder')
      assert.equal(january?.baseUnit, 'day')
      assert.equal(january?.invoicePresentation, 'summary')

      const february = await resolveItemRate({
        orgId: org.orgId, projectId: project, itemId: org.items.service,
        onDate: '2026-02-15', baseQuantity: '8',
      })
      assert.equal(february?.bill.amount, '60.0000')
      assert.equal(february?.policy, 'lowest_cost')
      assert.equal(february?.baseUnit, 'hour')
      assert.equal(february?.invoicePresentation, 'rate_components')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
