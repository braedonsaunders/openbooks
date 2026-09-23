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

const DB = !!process.env.OPENBOOKS_DB_URL

/**
 * A selected rate card without FX coverage must refuse — never fall through
 * to a lower-priority card. Project EUR card + default CAD card, no
 * EUR→CAD spot: the old resolver billed the CAD card and reported success.
 */
test('missing FX on the selected card refuses instead of billing a lower card', { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const project = randomUUID()
      const eurBook = randomUUID(), eurVersion = randomUUID()
      const cadBook = randomUUID(), cadVersion = randomUUID()
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'FXJOB', 'FX job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${eurBook}, ${org.orgId}, 'EUR-CARD', 'Project euro card', 'EUR', false, true),
               (${cadBook}, ${org.orgId}, 'CAD-DEFAULT', 'Default card', 'CAD', true, true)`)
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${eurVersion}, ${org.orgId}, ${eurBook}, '2020-01-01', 'draft', '{}'::jsonb),
               (${cadVersion}, ${org.orgId}, ${cadBook}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${eurVersion}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200),
               (${org.orgId}, ${cadVersion}, ${org.items.service}, 'hour', 'Hour', 1, 10, 20)`)
      await db.execute(sql`update item_rate_versions set status = 'active'
        where id = any(${`{${eurVersion},${cadVersion}}`}::uuid[]) and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
        values (${org.orgId}, ${eurBook}, ${eurVersion}, ${project}, 'usage_date', true)`)

      await assert.rejects(
        () => resolveItemRate({
          orgId: org.orgId, projectId: project, itemId: org.items.service,
          baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date,
        }),
        /No spot rate for EUR→CAD on or before 2026-07-15/,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

/**
 * Absence of an item/version still falls through: a project card that does
 * not cover the item bills the default card (same currency, no FX needed).
 */
test('a card without the item still falls through to the default card', { skip: !DB }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const project = randomUUID()
      const cadBook = randomUUID(), cadVersion = randomUUID()
      const defaultBook = randomUUID(), defaultVersion = randomUUID()
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'FALLJOB', 'Fall-through job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${cadBook}, ${org.orgId}, 'CAD-PROJECT', 'Project card', 'CAD', false, true),
               (${defaultBook}, ${org.orgId}, 'CAD-DEFAULT', 'Default card', 'CAD', true, true)`)
      // The project card covers the date but carries no line for the item.
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${cadVersion}, ${org.orgId}, ${cadBook}, '2020-01-01', 'draft', '{}'::jsonb),
               (${defaultVersion}, ${org.orgId}, ${defaultBook}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${defaultVersion}, ${org.items.service}, 'hour', 'Hour', 1, 10, 20)`)
      await db.execute(sql`update item_rate_versions set status = 'active'
        where id = any(${`{${cadVersion},${defaultVersion}}`}::uuid[]) and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
        values (${org.orgId}, ${cadBook}, ${cadVersion}, ${project}, 'usage_date', true)`)

      const resolved = await resolveItemRate({
        orgId: org.orgId, projectId: project, itemId: org.items.service,
        baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date,
      })
      assert.equal(resolved?.bill.amount, '20.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
