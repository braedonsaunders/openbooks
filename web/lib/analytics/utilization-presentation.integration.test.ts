import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { utilizationData } = await import('./utilization-data')

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencyTime() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const cadEmp = randomUUID()
  const usEmp = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${cadEmp}, ${org.orgId}, 'employee', 'CAD Worker', ${org.subsidiaryId}, true, '{}'::jsonb),
             (${usEmp}, ${org.orgId}, 'employee', 'US Worker', ${usSub}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // 10 non-billable hours each at a 50 rate stamped in the worker's own
    // functional — the posting kernel's own (subsidiary, currency) grouping.
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${cadEmp}, ${D}, '10.0000', 'approved', false, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${usEmp}, ${D}, '10.0000', 'approved', false, '50.0000', 'USD', ${usSub}, '{}'::jsonb)`)
  })
  return { org, cadEmp, usEmp }
}

/**
 * Non-billable cost is stated in presentation currency: USD 500 of time at
 * 1.35 is 675 CAD of cost — not 500 fused as base units.
 */
test('utilization translates every cost-rate functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, cadEmp, usEmp } = await seedTwoCurrencyTime()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await utilizationData(org.orgId, JULY, null)
      assert.equal(data.company.range.nonBillableCost, 1175)
      const cad = data.employees.find((e) => e.id === cadEmp)!
      const us = data.employees.find((e) => e.id === usEmp)!
      assert.equal(cad.range.nonBillableCost, 500)
      assert.equal(us.range.nonBillableCost, 675)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('utilization fails closed when a cost functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedTwoCurrencyTime()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(utilizationData(org.orgId, JULY, null), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
