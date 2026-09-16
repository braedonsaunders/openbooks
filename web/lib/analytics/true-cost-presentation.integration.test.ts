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
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { trueCostData } = await import('./true-cost-data')

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencyTrueCost() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const dept = randomUUID()
  const cadEmp = randomUUID()
  const usEmp = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Ops', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${cadEmp}, ${org.orgId}, 'employee', 'CAD Worker', ${org.subsidiaryId}, true, '{}'::jsonb),
             (${usEmp}, ${org.orgId}, 'employee', 'US Worker', ${usSub}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // 10 billed + 10 non-billable hours per worker at a 50 rate stamped in
    // the worker's own functional.
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${cadEmp}, ${D}, '10.0000', 'approved', true, ${dept}, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${cadEmp}, ${D}, '10.0000', 'approved', false, ${dept}, '50.0000', 'CAD', ${org.subsidiaryId}, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${usEmp}, ${D}, '10.0000', 'approved', true, ${dept}, '50.0000', 'USD', ${usSub}, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${usEmp}, ${D}, '10.0000', 'approved', false, ${dept}, '50.0000', 'USD', ${usSub}, '{}'::jsonb)`)
    // CAD 100 + USD 100 of burden-eligible expense on the Ops tag.
    for (const [num, sub, cur, amt] of [['TC-CAD', org.subsidiaryId, 'CAD', '100'], ['TC-USD', usSub, 'USD', '100']] as const) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${sub}, ${dept}, ${amt}, ${cur}, ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${sub}, ${dept}, ${'-' + amt}, ${cur}, ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
  })
  return { org, cadEmp, usEmp }
}

/**
 * True cost states presentation currency everywhere: USD 500 of non-billable
 * time is 675 CAD of burden (not 500), USD 100 of expense is 135 CAD of
 * unassigned burden (not 100), and no rate averages raw cross-currency rates.
 */
test('true cost translates every burden functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, cadEmp, usEmp } = await seedTwoCurrencyTrueCost()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      // Non-billable burden: 500 CAD + 675 CAD.
      assert.equal(data.kpis.totalOverhead, 1175)
      const timeCat = data.categories.find((c) => c.key === 'nonbillable_time')!
      assert.ok(timeCat, 'non-billable time category present')
      assert.equal(timeCat.totalAmount, 1175)
      // Unassigned expense: 100 CAD + 135 CAD.
      const unassigned = data.unassigned.find((u) => u.id === org.accounts.cogs)!
      assert.ok(unassigned, 'unassigned expense present')
      assert.equal(unassigned.amount, 235)
      // Employee rates translate before any averaging: 50 and 67.5.
      const cad = data.labor.employees.find((e) => e.id === cadEmp)!
      const us = data.labor.employees.find((e) => e.id === usEmp)!
      assert.equal(cad.rate, 50)
      assert.equal(us.rate, 67.5)
      assert.equal(data.labor.weighted, 58.75)
      // Monthly burden carries the translated time category.
      const july = data.monthly.find((m) => m.month === '2026-07')!
      assert.equal(july.burden, 1175)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('true cost fails closed when a burden functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedTwoCurrencyTrueCost()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(trueCostData(org.orgId, JULY, null), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
