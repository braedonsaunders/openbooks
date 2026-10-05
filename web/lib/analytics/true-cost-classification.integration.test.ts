import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    // No request scope here: the money formatter resolves its locale through
    // request cookies, so serve an empty jar (anonymous caller, default locale).
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export function cookies() { return { get() { return undefined } } }' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { trueCostData } = await import('./true-cost-data')

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

/**
 * Seeds the trap the old English-name classification fell into:
 * - `Overhead Burden Clearing` matches the old applied-account pattern but is
 *   NOT the configured application account;
 * - the real applied pair posts with origin 'overhead_applied' on the
 *   configured account under a name no pattern matches;
 * - `Wages and Salaries` matches the old labour pattern but sits outside the
 *   configured cost_pool / direct_labor group;
 * - `Field Crew Cost` matches no pattern and is pinned into direct_labor.
 */
async function seedClassificationTrap() {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const proj = randomUUID()
  const decoyApplied = randomUUID()
  const realApplied = randomUUID()
  const wageDecoy = randomUUID()
  const crewReal = randomUUID()
  const groupId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'Trap Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${proj}, ${org.orgId}, ${org.subsidiaryId}, 'TRAP-1', 'Trap job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    for (const [id, number, name] of [
      [decoyApplied, '5200', 'Overhead Burden Clearing'],
      [realApplied, '5210', 'Applied Overhead Account'],
      [wageDecoy, '6100', 'Wages and Salaries'],
      [crewReal, '6110', 'Field Crew Cost'],
    ] as const) {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    }
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'cost_pool', 'direct_labor', 'Direct labor', false, true)`)
    await db.execute(sql`insert into account_group_members (id, org_id, group_id, account_id, dimension)
      values (${randomUUID()}, ${org.orgId}, ${groupId}, ${crewReal}, 'cost_pool')`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: 'net_zero_pair', accountId: realApplied } })}::jsonb
      where id = ${org.orgId}`)
    // Ordinary expense postings on the decoy applied account and both labour
    // accounts (200 / 1000 / 600, department-tagged).
    for (const [num, accountId, amt] of [['TRAP-A', decoyApplied, '200'], ['TRAP-W', wageDecoy, '1000'], ['TRAP-C', crewReal, '600']] as const) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${accountId}, ${org.subsidiaryId}, ${dept}, ${amt}, 'CAD', ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, ${'-' + amt}, 'CAD', ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
    // The real applied pair: project-tagged +100 with its offsetting untagged
    // -100 on the SAME configured account (nets to zero account-wide).
    const applied = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${applied}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'TRAP-OVH', ${D}, ${org.periodId}, 'draft', 'overhead_applied')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, project_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${applied}, 1, ${realApplied}, ${org.subsidiaryId}, ${dept}, ${proj}, '100', 'CAD', '100', '1'),
             (${org.orgId}, ${applied}, 2, ${realApplied}, ${org.subsidiaryId}, ${dept}, null, '-100', 'CAD', '-100', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${applied}`)
  })
  return { org, dept }
}

/**
 * Applied overhead is the configured application account's
 * origin='overhead_applied' project-tagged legs (as listOverheadApplications
 * sums them) — never an English account-name pattern. The 200 on the
 * name-matching decoy and the pair's own offsetting leg are excluded, so
 * applied is exactly the 100 carried to the project.
 */
test('true cost reads applied overhead from the configured account and origin', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedClassificationTrap()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.hasBurdenGL, true)
      assert.equal(
        data.kpis.burdenApplied,
        100,
        'applied must be the project-tagged legs on the configured account (100), not the name-matching decoy (-200)',
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * With no applied postings there is nothing to compare against actuals:
 * applied, gap and absorption refuse by name instead of modelling
 * overhead × utilization (0 here) or falling back to 100%. The reason names
 * the missing mechanism and its remedy.
 */
test('true cost refuses absorption by name with no applied postings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'Refusal Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.hasBurdenGL, false)
      assert.equal(data.kpis.burdenApplied, null)
      assert.equal(data.kpis.gap, null)
      assert.equal(data.kpis.gapPerHour, null)
      assert.equal(data.kpis.absorptionPct, null)
      assert.ok(
        data.absorptionUnavailable?.includes('Setup → Overhead'),
        `refusal must name the remedy, got: ${data.absorptionUnavailable}`,
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Cascading with no costed labor and no explicit base rate refuses by name
 * instead of pricing every cascade at an assumed 50/hr: the profile sets
 * cascading with an empty base, the period's billed time carries no cost
 * rate, and a real burden category forces the composite to resolve.
 */
test('true cost cascading refuses by name with no costed labor and no base rate', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'Cascade Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7000', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CASC-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'Cascading', color: null, compositeMethod: 'cascading', baseLaborRate: '', fringeRate: '0.25', categorySettings: {}, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(
        trueCostData(org.orgId, JULY, null),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /needs a labor rate/);
          assert.match(error.message, /base labor rate/);
          return true;
        },
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Labour dollars are the configured cost_pool / direct_labor account set
 * (rule plus pin) — the same classification that excludes direct labour from
 * burden. The 1000 on the name-matching `Wages and Salaries` account is
 * excluded; the 600 on the pinned `Field Crew Cost` account is included.
 */
test('true cost reads labour dollars from the direct_labor group, not the name', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, dept } = await seedClassificationTrap()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(
        data.bases.laborDollars.byDept[dept],
        600,
        'labour base must be the pinned group member (600), not the name-matching account (1000)',
      )
      assert.equal(data.bases.laborDollars.total, 600)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
