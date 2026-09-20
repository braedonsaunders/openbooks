import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveItemRate } = await import('./item-rates.ts')
const { resolveRateAdjustments, findLapsedRateCard } = await import('./rate-adjustments.ts')

test('item rates honor location-scoped version cards', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const location = randomUUID()
    const project = randomUUID()
    const book = randomUUID()
    const version = randomUUID()
    await db.execute(sql`insert into locations (id, org_id, name, is_active) values (${location}, ${org.orgId}, 'Field location', true)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LOC-RATE', 'Location rate project', ${org.customerId}, 'active', true)`)
    await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
      values (${org.orgId}, ${org.items.service}, 'hour', true)`)
    await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_active)
      values (${book}, ${org.orgId}, 'LOCATION-RATES', 'Location rates', 'CAD', true)`)
    await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status)
      values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft')`)
    await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
      values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 40, 140)`)
    await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id)
      values (${org.orgId}, ${version}, 'location', ${location})`)
    await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
    await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, location_id, date_basis, is_active)
      values (${org.orgId}, ${book}, ${location}, 'usage_date', true)`)

    const resolved = await resolveItemRate({
      orgId: org.orgId,
      projectId: project,
      itemId: org.items.service,
      locationId: location,
      onDate: org.date,
      baseQuantity: '1',
      rateUnitCode: 'hour',
    })
    assert.equal(resolved?.bill.amount, '140.0000')
  } finally { await dropScratchOrg(org.orgId) }
})

test('child locations inherit version-scoped rates and adjustments when enabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const parent = randomUUID(), child = randomUUID()
    await db.execute(sql`insert into locations (id, org_id, name, is_active) values (${parent}, ${org.orgId}, 'Region', true)`)
    await db.execute(sql`insert into locations (id, org_id, parent_id, name, is_active) values (${child}, ${org.orgId}, ${parent}, 'Site', true)`)
    const project = randomUUID(), book = randomUUID(), version = randomUUID()
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'LOC-CHILD', 'Child location project', ${org.customerId}, 'active', true)`)
    await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
      values (${org.orgId}, ${org.items.service}, 'hour', true)`)
    await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_active)
      values (${book}, ${org.orgId}, 'LOCATION-CHILD-RATES', 'Child location rates', 'CAD', true)`)
    await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status)
      values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft')`)
    await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
      values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 45, 145)`)
    await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
      values (${org.orgId}, ${version}, 'location', ${parent}, true)`)
    await db.execute(sql`insert into labor_rate_adjustments (org_id, version_id, code, name, category, calculation, value, presentation)
      values (${org.orgId}, ${version}, 'SITE', 'Site premium', 'surcharge', 'percent', 5, 'separate')`)
    await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
    await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
      values (${org.orgId}, ${book}, 'usage_date', true)`)

    const resolved = await resolveItemRate({
      orgId: org.orgId, projectId: project, itemId: org.items.service,
      locationId: child, onDate: org.date, baseQuantity: '1', rateUnitCode: 'hour',
    })
    assert.equal(resolved?.bill.amount, '145.0000')
    const adjustments = await resolveRateAdjustments({ orgId: org.orgId, projectId: project, locationId: child, onDate: org.date })
    assert.deepEqual(adjustments.map((row) => ({ code: row.code, value: row.value })), [{ code: 'SITE', value: '5.0000000000' }])
    assert.equal(await findLapsedRateCard({ orgId: org.orgId, projectId: project, onDate: org.date }), null)
  } finally { await dropScratchOrg(org.orgId) }
})
