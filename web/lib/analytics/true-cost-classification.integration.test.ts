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
      [decoyApplied, '7810', 'Overhead Burden Clearing'],
      [realApplied, '7820', 'Applied Overhead Account'],
      [wageDecoy, '7830', 'Wages and Salaries'],
      [crewReal, '7840', 'Field Crew Cost'],
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
 * Applied legs are identified by the posting origin, never by the current
 * application account: after the configured account changes, history posted
 * to the old account still counts — a changed account must not erase the
 * period it replaces.
 */
test('true cost keeps applied history after the application account changes', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedClassificationTrap()
  const nextAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${nextAccount}, ${org.orgId}, '7821', 'Applied Overhead Account Two', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const before = await trueCostData(org.orgId, JULY, null)
      assert.equal(before.kpis.burdenApplied, 100)
      assert.equal(before.appliedSource, 'postings')
      await withBypass(async () => {
        await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: 'net_zero_pair', accountId: nextAccount } })}::jsonb
          where id = ${org.orgId}`)
      })
      const after = await trueCostData(org.orgId, JULY, null)
      assert.equal(after.hasBurdenGL, true)
      assert.equal(
        after.kpis.burdenApplied,
        100,
        'applied posted to the old account must survive the account change',
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * A report_only org never carries applied journals, so its eligible project
 * time prices against the published standard cards: 8 approved project
 * hours at a 25.00 card apply 200 against the 800 burden — absorption by
 * pricing, never by modelling.
 */
test('true cost prices absorption from published standard cards with no postings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const proj = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  const cardId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'Card Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${proj}, ${org.orgId}, ${org.subsidiaryId}, 'CARD-1', 'Card job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, project_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, ${proj}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CARD-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`insert into overhead_rates (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from)
      values (${cardId}, ${org.orgId}, ${dept}, 'Published', 'standard', 'per_hour', '25.0000', '2026-01-01')`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.hasBurdenGL, true)
      assert.equal(data.appliedSource, 'standard-cards')
      assert.equal(data.kpis.burdenApplied, 200)
      assert.equal(data.kpis.gap, -600)
      assert.equal(data.kpis.absorptionPct, 25)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Absorption math stays in exact decimals to the display boundary: applied
 * 0.10 + 0.20 against a 0.30 burden gaps exactly zero — a float path would
 * read 0.30000000000000004 as under-absorbed.
 */
test('true cost gaps exactly zero on exact decimal absorption', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const proj = randomUUID()
  const appliedAccount = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${proj}, ${org.orgId}, ${org.subsidiaryId}, 'EXACT-1', 'Exact job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
    for (const [id, number, name] of [
      [appliedAccount, '7820', 'Applied Overhead Account'],
      [rentAccount, '7850', 'Rent'],
    ] as const) {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    }
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: 'net_zero_pair', accountId: appliedAccount } })}::jsonb
      where id = ${org.orgId}`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${randomUUID()}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const applied = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${applied}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'EXACT-OVH', ${D}, ${org.periodId}, 'draft', 'overhead_applied')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, project_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${applied}, 1, ${appliedAccount}, ${org.subsidiaryId}, ${dept}, ${proj}, '0.10', 'CAD', '0.10', '1'),
             (${org.orgId}, ${applied}, 2, ${appliedAccount}, ${org.subsidiaryId}, ${dept}, ${proj}, '0.20', 'CAD', '0.20', '1'),
             (${org.orgId}, ${applied}, 3, ${appliedAccount}, ${org.subsidiaryId}, ${dept}, null, '-0.30', 'CAD', '-0.30', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${applied}`)
    const burden = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${burden}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'EXACT-B', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${burden}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '0.30', 'CAD', '0.30', '1'),
             (${org.orgId}, ${burden}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-0.30', 'CAD', '-0.30', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${burden}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.hasBurdenGL, true)
      assert.equal(data.kpis.burdenApplied, 0.3)
      assert.equal(data.kpis.gap, 0)
      assert.equal(data.kpis.absorptionPct, 100)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Company utilization excludes departments with zero billable hours across
 * the current and prior windows (the Utilization dashboard's no-bill rule):
 * 8 billed + 8 non-billable reads 100%, never 50%.
 */
test('true cost utilization excludes departments with no billable hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const billable = randomUUID()
  const nonbill = randomUUID()
  const empA = randomUUID()
  const empB = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${billable}, ${org.orgId}, 'Billable', true, '{}'::jsonb),
             (${nonbill}, ${org.orgId}, 'Nonbill', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${empA}, ${org.orgId}, 'employee', 'Billable Worker', ${org.subsidiaryId}, true, '{}'::jsonb),
             (${empB}, ${org.orgId}, 'employee', 'Nonbill Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${empA}, ${D}, '8.0000', 'approved', true, ${billable}, null, null, null, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${empB}, ${D}, '8.0000', 'approved', false, ${nonbill}, null, null, null, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${empA}, '2026-06-10', '8.0000', 'approved', true, ${billable}, null, null, null, '{}'::jsonb)`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.kpis.utilization, 1)
      assert.equal(data.kpis.billedHours, 8)
      assert.equal(data.kpis.totalHours, 8)
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
      values (${emp}, ${org.orgId}, 'employee', 'Refusal Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
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
      values (${emp}, ${org.orgId}, 'employee', 'Cascade Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
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
      // The refusal lands at the composite level: the payload, categories
      // and config still render, and only the composite figures are void.
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.compositeRefusal?.code, 'cascadingNoLabor');
      assert.ok(data.compositeRefusal?.message.includes('base labor rate'), 'the refusal must name the remedy');
      assert.equal(data.kpis.compositeRate, null);
      assert.equal(data.totals.overall, null);
      assert.equal(data.categories.length, 1);
      assert.equal(data.config.compositeMethod, 'cascading');
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Per-FTE display multiplies the hourly rate by measured annual hours: with
 * the employee's year-basis labor cost rate carrying 2000 annual hours, an
 * 800 burden over 8 billed hours (100/hr) displays 200000 per FTE — never
 * 208000 from an assumed 2080. Hourly rows carry the column default, never
 * a divisor, so the seed uses a year-basis row like the product writes.
 */
test('true cost per-FTE uses resolved annual hours, not 2080', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'FTE Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from)
      values (${org.orgId}, ${emp}, 'CAD', 80000, 'year', 2000, '2026-01-01')`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'FTE-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'FTE', color: null, compositeMethod: 'sum', baseLaborRate: '', fringeRate: '0.25', categorySettings: { [groupId]: { rateFormat: 'per_fte' } }, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(
        rent.byDept[dept]?.rate,
        200000,
        'per-FTE rate must be 100/hr x measured 2000 annual hours, not 208000 from an assumed 2080',
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Per-FTE with no resolvable annual hours refuses naming the category and
 * the remedy: same shape as above but no labor cost rate and no schedule.
 */
test('true cost per-FTE refuses by name with no annual hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'FTE Refusal Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'FTE-2', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'FTE', color: null, compositeMethod: 'sum', baseLaborRate: '', fringeRate: '0.25', categorySettings: { [groupId]: { rateFormat: 'per_fte' } }, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      // The refusal lands at the composite level naming the category (by
      // name, never UUID): the category still renders with its expense, and
      // only its rate and the composite figures are void.
      const data = await trueCostData(org.orgId, JULY, null)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(data.compositeRefusal?.code, 'perFteNoHours');
      assert.ok(data.compositeRefusal?.message.includes('Rent'), 'the refusal must name the category');
      assert.ok(data.compositeRefusal?.message.includes('annual FTE hours'), 'the refusal must name the missing input');
      assert.ok(data.compositeRefusal?.message.includes('labor cost rates'), 'the refusal must name the remedy');
      assert.equal(rent.rate, null);
      assert.equal(data.kpis.compositeRate, null);
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * A department with no resolvable annual hours refuses by department name
 * while the Overall headline still computes: the Field employee's
 * year-basis rate resolves the Overall divisor, the Shop employee carries
 * no rate and no schedule, so only the Shop scope voids.
 */
test('true cost per-FTE refusal names the department for a department without hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const field = randomUUID()
  const shop = randomUUID()
  const empField = randomUUID()
  const empShop = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${field}, ${org.orgId}, 'Field', true, '{}'::jsonb),
             (${shop}, ${org.orgId}, 'Shop', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${empField}, ${org.orgId}, 'employee', 'Field Worker', ${org.subsidiaryId}, true, '{}'::jsonb),
             (${empShop}, ${org.orgId}, 'employee', 'Shop Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${empField}, ${D}, '8.0000', 'approved', true, ${field}, null, null, null, '{}'::jsonb),
             (${randomUUID()}, ${org.orgId}, ${empShop}, ${D}, '8.0000', 'approved', true, ${shop}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from)
      values (${org.orgId}, ${empField}, 'CAD', 80000, 'year', 2000, '2026-01-01')`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'FTE-3', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${field}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${field}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'FTE', color: null, compositeMethod: 'sum', baseLaborRate: '', fringeRate: '0.25', categorySettings: { [groupId]: { rateFormat: 'per_fte' } }, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.compositeRefusal?.code, 'perFteNoHoursDept');
      assert.ok(data.compositeRefusal?.message.includes('Shop'), 'the refusal must name the department, never its UUID');
      assert.ok(!(data.compositeRefusal?.message ?? '').includes(shop), 'the refusal must not leak the department UUID');
      assert.ok(data.compositeRefusal?.message.includes('Rent'), 'the refusal must name the category');
      // The Overall headline and the Field scope stay priced.
      assert.notEqual(data.kpis.compositeRate, null);
      const shopDept = data.departments.find((d) => d.id === shop)!
      assert.ok(shopDept, 'shop department present')
      assert.equal(shopDept.composite, null);
      assert.equal(data.totals.byDept[shop], null);
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * A work schedule annualizes from its own cycle: a 40-hour week on a 7-day
 * cycle resolves 40 × 365 ÷ 7 = 2085.7143 annual hours — never 2080 from a
 * bare ×52, which assumes a 364-day year.
 */
test('true cost per-FTE annualizes a work schedule from its own cycle', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  const scheduleId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'Schedule Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days, cycle_anchor, effective_from, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Full time', ${emp}, 'cycle', 7, '2026-01-04', '2026-01-01', true, null, null)`)
    for (const dayIndex of [1, 2, 3, 4, 5]) {
      await db.execute(sql`insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
        values (${org.orgId}, ${scheduleId}, ${dayIndex}, '8', null, null)`)
    }
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'FTE-4', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, ${dept}, '800', 'CAD', '800', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, '-800', 'CAD', '-800', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'FTE', color: null, compositeMethod: 'sum', baseLaborRate: '', fringeRate: '0.25', categorySettings: { [groupId]: { rateFormat: 'per_fte' } }, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(
        rent.byDept[dept]?.rate,
        208571.43,
        'per-FTE rate must be 100/hr x 40×365÷7 annual hours, not 208000 from a bare ×52',
      )
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Headcount aggregates once per department: with GL activity in two
 * functionals (CAD at home, USD abroad) and one employee working in the
 * department, the headcount base is 1 — never 2 (once per currency).
 */
test('true cost counts headcount once per department across currencies', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const dept = randomUUID()
  const emp = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'Headcount Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    for (const [num, sub, cur, amt] of [['HC-CAD', org.subsidiaryId, 'CAD', '100'], ['HC-USD', usSub, 'USD', '100']] as const) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${sub}, ${dept}, ${amt}, ${cur}, ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${sub}, ${dept}, ${'-' + amt}, ${cur}, ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(
        data.bases.headcount.byDept[dept],
        1,
        'one employee in a two-currency department is a headcount of 1, not 2',
      )
      assert.equal(data.bases.headcount.total, 1)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Approved non-billable time with no cost rate is counted as unrated hours,
 * never priced at zero: the labor section carries the exact hours and the
 * native time category flags them by name.
 */
test('true cost counts unrated hours instead of pricing them at zero', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Field', true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${emp}, ${org.orgId}, 'employee', 'Unrated Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, '8.0000', 'approved', false, ${dept}, null, null, null, '{}'::jsonb)`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      assert.equal(data.labor.unratedHours, '8.0000')
      const timeCat = data.categories.find((c) => c.key === 'nonbillable_time')!
      assert.ok(timeCat, 'time category surfaces so the gap is named')
      assert.equal(timeCat.unratedHours, '8.0000')
      assert.equal(timeCat.totalAmount, 0)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Untagged expense follows the category's own allocation base: with the
 * rent category set to headcount and one headcount in each of two
 * departments (8 billed hours against 1), an untagged 900 splits 450/450 —
 * never 800/100 by billed hours.
 */
test('true cost splits untagged expense by the category allocation base', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const deptA = randomUUID()
  const deptB = randomUUID()
  const empA = randomUUID()
  const empB = randomUUID()
  const groupId = randomUUID()
  const rentAccount = randomUUID()
  await withBypass(async () => {
    for (const [dept, name] of [[deptA, 'Field A'], [deptB, 'Field B']] as const) {
      await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
        values (${dept}, ${org.orgId}, ${name}, true, '{}'::jsonb)`)
    }
    for (const [emp, name, dept, hours] of [[empA, 'Split A', deptA, '8.0000'], [empB, 'Split B', deptB, '1.0000']] as const) {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${emp}, ${org.orgId}, 'employee', ${name}, ${org.subsidiaryId}, true, '{}'::jsonb)`)
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
        values (${randomUUID()}, ${org.orgId}, ${emp}, ${D}, ${hours}, 'approved', true, ${dept}, '50.0000', 'CAD', null, '{}'::jsonb)`)
    }
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${rentAccount}, ${org.orgId}, '7850', 'Rent', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
      values (${groupId}, ${org.orgId}, 'burden', 'rent', 'Rent', '{"accountTypes":["expense"],"numberPrefixes":["7"]}'::jsonb, false, true)`)
    const entry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'SPLIT-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${rentAccount}, ${org.subsidiaryId}, null, '900', 'CAD', '900', '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, null, '-900', 'CAD', '-900', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'Split', color: null, compositeMethod: 'sum', baseLaborRate: '', fringeRate: '0.25', categorySettings: { [groupId]: { allocationBase: 'headcount' } }, customCategories: [], baseOverrides: {} }] } } })}::jsonb
      where id = ${org.orgId}`)
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await trueCostData(org.orgId, JULY, null)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(rent.byDept[deptA]?.amount, 450)
      assert.equal(rent.byDept[deptB]?.amount, 450)
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
