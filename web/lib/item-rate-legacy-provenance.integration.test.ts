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
 * U9: a January version priced under capped_ladder, whose profile changed to
 * lowest_cost in February before the upgrade, gets pinned lowest_cost by the
 * 0298 backfill — so a late January entry after the upgrade would use
 * February's policy while the version looks historically authoritative.
 *
 * The backfilled pin is legacy (0326): retrospective pricing still prices
 * (field work must bill), but the resolution carries an explicit 'inferred'
 * provenance the UI shows, instead of presenting February's policy as
 * January's record. Writer pins stay 'pinned'; versions without a pin read
 * the live profile as 'live'.
 */
test('a late entry on a legacy pin prices on with inferred provenance', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const project = randomUUID(), book = randomUUID()
      const vJan = randomUUID(), vFeb = randomUUID(), vMar = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LEGACY-PIN', 'Legacy pin job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'LEGACY-PIN', 'Legacy pin book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
        values (${org.orgId}, ${book}, 'usage_date', true)`)
      // The live profile carries February's policy (the edit before upgrade).
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, pricing_policy, invoice_presentation, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components', true)`)
      for (const [version, from, to] of [[vJan, '2026-01-01', '2026-01-31'], [vFeb, '2026-02-01', '2026-02-28'], [vMar, '2026-03-01', null]] as const) {
        await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, effective_to, status, custom)
          values (${version}, ${org.orgId}, ${book}, ${from}, ${to}, 'draft', '{}'::jsonb)`)
        await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
          values (${org.orgId}, ${version}, ${org.items.service}, 'one', 'One', 1, 10, 10),
                 (${org.orgId}, ${version}, ${org.items.service}, 'four', 'Four', 4, 30, 30),
                 (${org.orgId}, ${version}, ${org.items.service}, 'six', 'Six', 6, 50, 50)`)
      }
      await db.execute(sql`update item_rate_versions set status = 'active' where org_id = ${org.orgId} and rate_book_id = ${book}`)
      // January's pin holds January's policy; February's holds February's.
      // March has no pin (a labor-style version resolving live).
      const janPin = randomUUID()
      await db.execute(sql`insert into item_rate_version_profiles (id, org_id, version_id, item_id, base_unit, pricing_policy, invoice_presentation)
        values (${janPin}, ${org.orgId}, ${vJan}, ${org.items.service}, 'day', 'capped_ladder', 'summary'),
               (${randomUUID()}, ${org.orgId}, ${vFeb}, ${org.items.service}, 'hour', 'lowest_cost', 'rate_components')`)
      // The upgrade marks January's pin: the backfill copied the live
      // profile, so its capped_ladder value is inferred, not recorded.
      await db.execute(sql`insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
        values (${org.orgId}, '0298_item_rate_version_profile_pins', 'item_rate_version_profiles', ${janPin}, 'test mark')`)

      const base = { orgId: org.orgId, projectId: project, itemId: org.items.service, baseQuantity: '8' } as const
      const january = await resolveItemRate({ ...base, onDate: '2026-01-15' })
      assert.equal(january?.bill.amount, '70.0000')
      assert.equal(january?.policy, 'capped_ladder')
      assert.equal(january?.policyProvenance, 'inferred')

      const february = await resolveItemRate({ ...base, onDate: '2026-02-15' })
      assert.equal(february?.bill.amount, '60.0000')
      assert.equal(february?.policy, 'lowest_cost')
      assert.equal(february?.policyProvenance, 'pinned')

      const march = await resolveItemRate({ ...base, onDate: '2026-03-15' })
      assert.equal(march?.policy, 'lowest_cost')
      assert.equal(march?.policyProvenance, 'live')
    } finally {
      await db.execute(sql`delete from upgrade_legacy_provenance where org_id = ${org.orgId}`)
      await dropScratchOrg(org.orgId)
    }
  })
})
