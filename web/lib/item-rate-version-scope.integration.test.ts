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
const { resolveItemRate, snapshotTimeBillRates } = await import('./item-rates')
const { resolveRateAdjustments } = await import('./rate-adjustments')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * A version scoped to one department must not price another department's
 * work. The surcharge resolver already enforces version scopes, and its own
 * contract demands the card and its surcharges never disagree about which
 * agreement is in force — the rate resolvers must apply the same rule, or a
 * job is billed one card's rates with another card's surcharges.
 */
test('version scopes gate rate resolution, not just surcharges', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const deptParent = randomUUID(), deptA = randomUUID(), deptB = randomUUID()
      await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${deptParent}, ${org.orgId}, 'Scoped parent', true)`)
      await db.execute(sql`insert into departments (id, org_id, parent_id, name, is_active) values (${deptA}, ${org.orgId}, ${deptParent}, 'Scoped child', true)`)
      await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${deptB}, ${org.orgId}, 'Other', true)`)
      const employee = randomUUID(), project = randomUUID(), book = randomUUID(), version = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Scoped worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`update items set default_rate = '50.0000' where id = ${org.items.service} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'SCOPED', 'Scoped rates job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'SCOPED-RATES', 'Scoped rates book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200)`)
      await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
        values (${org.orgId}, ${version}, 'department', ${deptParent}, true)`)
      await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, date_basis, is_active)
        values (${org.orgId}, ${book}, 'usage_date', true)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, item_id, project_id,
                              department_id, status, is_billable, billing_status, custom, created_by, updated_by)
        values (${entry}, ${org.orgId}, ${employee}, ${org.date}, '2.0000', ${org.items.service}, ${project},
                ${deptB}, 'approved', true, 'unbilled', '{}'::jsonb, ${org.orgId}, ${org.orgId})`)

      // The scoped card prices its own department…
      const scoped = await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptA, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date })
      assert.equal(scoped?.bill.amount, '200.0000')
      // …but must not price the other department's work.
      assert.equal(await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptB, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date }), null)
      // The snapshot path must agree: the other department falls back to the item default.
      assert.equal((await snapshotTimeBillRates(org.orgId, [entry], { dryRun: true })).get(entry), '50.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})

test('project assignments keep scoped item rates aligned with surcharges', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const deptA = randomUUID(), deptB = randomUUID()
      for (const [id, name] of [[deptA, 'Project scoped'], [deptB, 'Other project dept']] as const) {
        await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${id}, ${org.orgId}, ${name}, true)`)
      }
      const employee = randomUUID(), project = randomUUID(), book = randomUUID(), version = randomUUID(), entry = randomUUID(), adjustment = randomUUID()
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Project scoped worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`update items set default_rate = '50.0000' where id = ${org.items.service} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_profiles (org_id, item_id, base_unit, is_active)
        values (${org.orgId}, ${org.items.service}, 'hour', true)`)
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'PROJECT-SCOPED', 'Project-scoped rates job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
        values (${book}, ${org.orgId}, 'PROJECT-SCOPED-RATES', 'Project-scoped rates book', 'CAD', false, true)`)
      await db.execute(sql`insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
        values (${version}, ${org.orgId}, ${book}, '2020-01-01', 'draft', '{}'::jsonb)`)
      await db.execute(sql`insert into item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity, cost_rate, bill_rate)
        values (${org.orgId}, ${version}, ${org.items.service}, 'hour', 'Hour', 1, 100, 200)`)
      await db.execute(sql`insert into labor_rate_version_scopes (org_id, version_id, scope_type, scope_value_id, include_children)
        values (${org.orgId}, ${version}, 'department', ${deptA}, true)`)
      await db.execute(sql`insert into labor_rate_adjustments (id, org_id, version_id, code, name, category, calculation, value, presentation)
        values (${adjustment}, ${org.orgId}, ${version}, 'PROJECT-FUEL', 'Project fuel', 'surcharge', 'percent', 10, 'separate')`)
      await db.execute(sql`update item_rate_versions set status = 'active' where id = ${version} and org_id = ${org.orgId}`)
      await db.execute(sql`insert into item_rate_book_assignments (org_id, rate_book_id, rate_version_id, project_id, date_basis, is_active)
        values (${org.orgId}, ${book}, ${version}, ${project}, 'usage_date', true)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, item_id, project_id,
                              department_id, status, is_billable, billing_status, custom, created_by, updated_by)
        values (${entry}, ${org.orgId}, ${employee}, ${org.date}, '2.0000', ${org.items.service}, ${project},
                ${deptB}, 'approved', true, 'unbilled', '{}'::jsonb, ${org.orgId}, ${org.orgId})`)

      // A project assignment is an explicit card selection. The surcharge
      // resolver deliberately lets it override the version's narrower scope;
      // item-rate and snapshot resolution must make the same choice.
      const itemRate = await resolveItemRate({ orgId: org.orgId, projectId: project, itemId: org.items.service, departmentId: deptB, baseQuantity: '1', rateUnitCode: 'hour', onDate: org.date })
      const adjustments = await resolveRateAdjustments({ orgId: org.orgId, projectId: project, departmentId: deptB, onDate: org.date })
      assert.equal(adjustments.length, 1)
      assert.equal(itemRate?.bill.amount, '200.0000')
      assert.equal((await snapshotTimeBillRates(org.orgId, [entry], { dryRun: true })).get(entry), '200.0000')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
