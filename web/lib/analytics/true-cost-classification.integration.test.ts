import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test, { before } from 'node:test'

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
const { createScratchOrg, dropScratchOrg, assertDedicatedFixtureDatabase } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { JULY, withTrueCostOrg } = await import('@openbooks/engine/src/testing/true-cost-fixtures.ts')
const { trueCostData } = await import('./true-cost-data')
const { withAnalyticsRead } = await import('./read-context')

before(async () => { if (env.OPENBOOKS_DB_URL) await assertDedicatedFixtureDatabase() })

const load = (orgId: string) => trueCostData(orgId, JULY, null)
const loadSelected = (orgId: string, tab: string, projection: 'tab' | 'summary' = 'tab') => withAnalyticsRead({
  authz: { user: { orgId, id: randomUUID() }, permissions: new Set(['reports.read']), allowedSubsidiaryIds: null } as unknown as import('../authz').Authz,
  slug: 'true-cost', projection, tab, locale: 'en', revision: randomUUID(), observedAt: Date.now(),
}, () => load(orgId))
const RENT = { number: '7850', name: 'Rent' }
const rentJournal = (tag: string, amount: string, dept: number | null = 0) => ({
  entry: tag,
  lines: [
    { account: 0 as const, dept, amount },
    { account: 'bank' as const, dept, amount: `-${amount}` },
  ],
})

/**
 * Seeds the trap the old English-name classification fell into:
 * - `Overhead Burden Clearing` matches the old applied-account pattern but is
 *   NOT the configured application account;
 * - the real applied pair posts with origin 'overhead_applied' on the
 *   configured account under a name no pattern matches;
 * - `Wages and Salaries` matches the old labour pattern but sits outside the
 *   configured cost_pool / direct_labor group;
 * - `Field Crew Cost` matches no pattern and is pinned into direct_labor.
 * A second applied account ships unconfigured so the history test can move
 * the application account mid-period.
 */
async function seedClassificationTrap() {
  const org = await withBypass(() => createScratchOrg())
  const dept = randomUUID()
  const emp = randomUUID()
  const proj = randomUUID()
  const decoyApplied = randomUUID()
  const realApplied = randomUUID()
  const nextApplied = randomUUID()
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
      values (${randomUUID()}, ${org.orgId}, ${emp}, '2026-07-14', '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    for (const [id, number, name] of [
      [decoyApplied, '7810', 'Overhead Burden Clearing'],
      [realApplied, '7820', 'Applied Overhead Account'],
      [nextApplied, '7821', 'Applied Overhead Account Two'],
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
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, '2026-07-14', ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${accountId}, ${org.subsidiaryId}, ${dept}, ${amt}, 'CAD', ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${dept}, ${'-' + amt}, 'CAD', ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
    // The real applied pair: project-tagged +100 with its offsetting untagged
    // -100 on the SAME configured account (nets to zero account-wide).
    const applied = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${applied}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'TRAP-OVH', '2026-07-14', ${org.periodId}, 'draft', 'overhead_applied')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, project_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${applied}, 1, ${realApplied}, ${org.subsidiaryId}, ${dept}, ${proj}, '100', 'CAD', '100', '1'),
             (${org.orgId}, ${applied}, 2, ${realApplied}, ${org.subsidiaryId}, ${dept}, null, '-100', 'CAD', '-100', '1')`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${applied}`)
  })
  return { org, dept, nextApplied }
}

/**
 * Applied overhead is the configured application account's
 * origin='overhead_applied' project-tagged legs (as listOverheadApplications
 * sums them) — never an English account-name pattern. The 200 on the
 * name-matching decoy and the pair's own offsetting leg are excluded, so
 * applied is exactly the 100 carried to the project — and applied legs stay
 * identified by posting origin when the configured account changes, so the
 * history posted to the old account survives.
 */
test('true cost reads applied overhead by origin and keeps it across an account change', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, nextApplied } = await seedClassificationTrap()
  try {
    await withOrgContext(org.orgId, async () => {
      const before = await load(org.orgId)
      assert.equal(before.hasBurdenGL, true)
      assert.equal(
        before.kpis.burdenApplied,
        100,
        'applied must be the project-tagged legs on the configured account (100), not the name-matching decoy (-200)',
      )
      assert.equal(before.appliedSource, 'postings')
      await withBypass(async () => {
        await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: 'net_zero_pair', accountId: nextApplied } })}::jsonb
          where id = ${org.orgId}`)
      })
      const after = await load(org.orgId)
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
 * Labour dollars are the configured cost_pool / direct_labor account set
 * (rule plus pin) — the same classification that excludes direct labour from
 * burden. The 1000 on the name-matching `Wages and Salaries` account is
 * excluded; the 600 on the pinned `Field Crew Cost` account is included.
 */
test('true cost reads labour dollars from the direct_labor group, not the name', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, dept } = await seedClassificationTrap()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await load(org.orgId)
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

/**
 * A report_only org never carries applied journals, so its eligible project
 * time prices against the published standard cards: 8 approved project
 * hours at a 25.00 card apply 200 against the 800 burden — absorption by
 * pricing, never by modelling.
 */
test('true cost prices absorption from published standard cards with no postings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      employees: [{ name: 'Card Worker', dept: 0, project: 0 }],
      projects: ['CARD-1'],
      burdenAccounts: [RENT],
      journals: [rentJournal('CARD-1', '800')],
      cards: [{ dept: 0, category: 'Published', rate: '25.0000' }],
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      assert.equal(data.hasBurdenGL, true)
      assert.equal(data.appliedSource, 'standard-cards')
      assert.equal(data.kpis.burdenApplied, 200)
      assert.equal(data.kpis.gap, -600)
      assert.equal(data.kpis.absorptionPct, 25)
    },
  )
})

/**
 * Absorption math stays in exact decimals to the display boundary: applied
 * 0.10 + 0.20 against a 0.30 burden gaps exactly zero — a float path would
 * read 0.30000000000000004 as under-absorbed.
 */
test('true cost gaps exactly zero on exact decimal absorption', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      projects: ['EXACT-1'],
      burdenAccounts: [
        { number: '7820', name: 'Applied Overhead Account' },
        RENT,
      ],
      journals: [
        {
          entry: 'EXACT-OVH',
          origin: 'overhead_applied',
          lines: [
            { account: 0, dept: 0, project: 0, amount: '0.10' },
            { account: 0, dept: 0, project: 0, amount: '0.20' },
            { account: 0, dept: null, amount: '-0.30' },
          ],
        },
        rentJournal('EXACT-B', '0.30'),
      ],
      overheadApplication: { mode: 'net_zero_pair', account: 0 },
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      assert.equal(data.hasBurdenGL, true)
      assert.equal(data.kpis.burdenApplied, 0.3)
      assert.equal(data.kpis.gap, 0)
      assert.equal(data.kpis.absorptionPct, 100)
    },
  )
})

/**
 * Company utilization excludes departments with zero billable hours across
 * the current and prior windows (the Utilization dashboard's no-bill rule):
 * 8 billed + 8 non-billable reads 100%, never 50%.
 */
test('true cost utilization excludes departments with no billable hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      depts: ['Billable', 'Nonbill'],
      employees: [
        { name: 'Billable Worker', dept: 0, priorHours: '8.0000' },
        { name: 'Nonbill Worker', dept: 1, billable: false, rate: null },
      ],
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      assert.equal(data.kpis.utilization, 1)
      assert.equal(data.kpis.billedHours, 8)
      assert.equal(data.kpis.totalHours, 8)
    },
  )
})

/**
 * With no applied postings there is nothing to compare against actuals:
 * applied, gap and absorption refuse by name instead of modelling
 * overhead × utilization (0 here) or falling back to 100%. The reason names
 * the missing mechanism and its remedy.
 */
test('true cost refuses absorption by name with no applied postings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    { employees: [{ name: 'Refusal Worker', dept: 0 }] },
    async (seed) => {
      const data = await load(seed.org.orgId)
      assert.equal(data.hasBurdenGL, false)
      assert.equal(data.kpis.burdenApplied, null)
      assert.equal(data.kpis.gap, null)
      assert.equal(data.kpis.gapPerHour, null)
      assert.equal(data.kpis.absorptionPct, null)
      assert.ok(
        data.absorptionUnavailable?.includes('Setup → Overhead'),
        `refusal must name the remedy, got: ${data.absorptionUnavailable}`,
      )
    },
  )
})

/**
 * Cascading with no costed labor and no explicit base rate refuses by name
 * instead of pricing every cascade at an assumed 50/hr: the profile sets
 * cascading with an empty base, the period's billed time carries no cost
 * rate, and a real burden category forces the composite to resolve.
 */
test('true cost cascading refuses by name with no costed labor and no base rate', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      employees: [{ name: 'Cascade Worker', dept: 0 }],
      burdenAccounts: [RENT],
      journals: [rentJournal('CASC-1', '800')],
      profile: { name: 'Cascading', compositeMethod: 'cascading' },
    },
    async (seed) => {
      // The refusal lands at the composite level: the payload, categories
      // and config still render, and only the composite figures are void.
      const data = await load(seed.org.orgId)
      assert.equal(data.compositeRefusal?.code, 'cascadingNoLabor')
      assert.ok(data.compositeRefusal?.message.includes('base labor rate'), 'the refusal must name the remedy')
      assert.equal(data.kpis.compositeRate, null)
      assert.equal(data.totals.overall, null)
      assert.equal(data.categories.length, 1)
      assert.equal(data.config.compositeMethod, 'cascading')
      const selected = await loadSelected(seed.org.orgId, 'categories')
      assert.deepEqual(selected.compositeRefusal, data.compositeRefusal)
      assert.equal(selected.totals.overall, null)
    },
  )
})

test('selected true cost views retain the measured cascading labour base', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg({
    employees: [{ name: 'Costed Worker', dept: 0, hours: '8', rate: '4' }],
    burdenAccounts: [RENT], journals: [rentJournal('CASCADE-VIEW', '800')],
    profile: { name: 'Cascading', compositeMethod: 'cascading' },
  }, async (seed) => {
    const full = await load(seed.org.orgId)
    assert.equal(full.compositeRefusal, null)
    assert.equal(full.departments[0]?.composite, 100)
    for (const [projection, tab] of [['tab', 'categories'], ['tab', 'matrix'], ['summary', '']] as const) {
      const selected = await loadSelected(seed.org.orgId, tab, projection)
      assert.deepEqual(selected.compositeRefusal, full.compositeRefusal)
      assert.deepEqual(selected.departments, full.departments)
      assert.deepEqual(selected.totals, full.totals)
    }
  })
})

/**
 * Per-FTE display multiplies the hourly rate by measured annual hours: with
 * the employee's year-basis labor cost rate carrying 2000 annual hours, an
 * 800 burden over 8 billed hours (100/hr) displays 200000 per FTE — never
 * 208000 from an assumed 2080. Hourly rows carry the column default, never
 * a divisor, so the seed uses a year-basis row like the product writes.
 */
test('true cost per-FTE uses resolved annual hours, not 2080', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      employees: [{ name: 'FTE Worker', dept: 0 }],
      burdenAccounts: [RENT],
      journals: [rentJournal('FTE-1', '800')],
      wageRates: [{ emp: 0, annualHours: 2000 }],
      profile: { name: 'FTE', categoryGroups: [{ group: 0, rateFormat: 'per_fte' }] },
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(
        rent.byDept[seed.deptIds[0]!]?.rate,
        200000,
        'per-FTE rate must be 100/hr x measured 2000 annual hours, not 208000 from an assumed 2080',
      )
      for (const [projection, tab] of [['tab', 'categories'], ['tab', 'matrix'], ['summary', '']] as const) {
        const selected = await loadSelected(seed.org.orgId, tab, projection)
        assert.deepEqual(selected.categories.find((c) => c.key === 'rent')?.byDept, rent.byDept)
        assert.deepEqual(selected.compositeRefusal, data.compositeRefusal)
      }
      // A custom category can be the only annual-hours consumer.
      const customId = randomUUID()
      const written = await db.execute(sql`update orgs set settings =
        jsonb_set(jsonb_set(settings, '{analytics,trueCost,profiles,0,categorySettings}', '{}'::jsonb),
          '{analytics,trueCost,profiles,0,customCategories}', ${JSON.stringify([{
            id: customId, name: 'Annual allowance', color: null, type: 'manual',
            allocationBase: 'billed_hours', rateFormat: 'per_fte', includeInComposite: false,
            manualConfig: { entryMode: 'fixed_total', fixedTotal: '800' },
          }])}::jsonb)
        where id = ${seed.org.orgId} returning id`)
      assert.equal(written.rows.length, 1)
      const customFull = (await load(seed.org.orgId)).categories.find((c) => c.id === customId)!
      assert.equal(customFull.byDept[seed.deptIds[0]!]!.rate, 200000)
      const customSelected = await loadSelected(seed.org.orgId, 'categories')
      assert.deepEqual(customSelected.categories.find((c) => c.id === customId)?.byDept, customFull.byDept)
    },
  )
})

/**
 * Per-FTE with no resolvable annual hours refuses naming the category and
 * the remedy: same shape as above but no labor cost rate and no schedule.
 */
test('true cost per-FTE refuses by name with no annual hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      employees: [{ name: 'FTE Refusal Worker', dept: 0 }],
      burdenAccounts: [RENT],
      journals: [rentJournal('FTE-2', '800')],
      profile: { name: 'FTE', categoryGroups: [{ group: 0, rateFormat: 'per_fte' }] },
    },
    async (seed) => {
      // The refusal lands at the composite level naming the category (by
      // name, never UUID): the category still renders with its expense, and
      // only its rate and the composite figures are void.
      const data = await load(seed.org.orgId)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(data.compositeRefusal?.code, 'perFteNoHours')
      assert.ok(data.compositeRefusal?.message.includes('Rent'), 'the refusal must name the category')
      assert.ok(data.compositeRefusal?.message.includes('annual FTE hours'), 'the refusal must name the missing input')
      assert.ok(data.compositeRefusal?.message.includes('labor cost rates'), 'the refusal must name the remedy')
      assert.equal(rent.rate, null)
      assert.equal(data.kpis.compositeRate, null)
      const selected = await loadSelected(seed.org.orgId, 'categories')
      assert.deepEqual(selected.compositeRefusal, data.compositeRefusal)
      assert.equal(selected.categories.find((c) => c.key === 'rent')?.rate, null)
    },
  )
})

/**
 * A department with no resolvable annual hours refuses by department name
 * while the Overall headline still computes: the Field employee's
 * year-basis rate resolves the Overall divisor, the Shop employee carries
 * no rate and no schedule, so only the Shop scope voids.
 */
test('true cost per-FTE refusal names the department for a department without hours', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      depts: ['Field', 'Shop'],
      employees: [
        { name: 'Field Worker', dept: 0 },
        { name: 'Shop Worker', dept: 1 },
      ],
      burdenAccounts: [RENT],
      journals: [{ entry: 'FTE-3', lines: [{ account: 0, dept: 0, amount: '800' }, { account: 'bank', dept: 0, amount: '-800' }] }],
      wageRates: [{ emp: 0, annualHours: 2000 }],
      profile: { name: 'FTE', categoryGroups: [{ group: 0, rateFormat: 'per_fte' }] },
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      const shop = seed.deptIds[1]!
      assert.equal(data.compositeRefusal?.code, 'perFteNoHoursDept')
      assert.ok(data.compositeRefusal?.message.includes('Shop'), 'the refusal must name the department, never its UUID')
      assert.ok(!(data.compositeRefusal?.message ?? '').includes(shop), 'the refusal must not leak the department UUID')
      assert.ok(data.compositeRefusal?.message.includes('Rent'), 'the refusal must name the category')
      // The Overall headline and the Field scope stay priced.
      assert.notEqual(data.kpis.compositeRate, null)
      const shopDept = data.departments.find((d) => d.id === shop)!
      assert.ok(shopDept, 'shop department present')
      assert.equal(shopDept.composite, null)
      assert.equal(data.totals.byDept[shop], null)
    },
  )
})

/**
 * A work schedule annualizes from its own cycle: a 40-hour week on a 7-day
 * cycle resolves 40 × 365 ÷ 7 = 2085.7143 annual hours — never 2080 from a
 * bare ×52, which assumes a 364-day year.
 */
test('true cost per-FTE annualizes a work schedule from its own cycle', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      employees: [{ name: 'Schedule Worker', dept: 0 }],
      burdenAccounts: [RENT],
      journals: [rentJournal('FTE-4', '800')],
      schedules: [{ emp: 0, cycleDays: 7, dailyHours: [8, 8, 8, 8, 8] }],
      profile: { name: 'FTE', categoryGroups: [{ group: 0, rateFormat: 'per_fte' }] },
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(
        rent.byDept[seed.deptIds[0]!]?.rate,
        208571.43,
        'per-FTE rate must be 100/hr x 40×365÷7 annual hours, not 208000 from a bare ×52',
      )
    },
  )
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
      values (${randomUUID()}, ${org.orgId}, ${emp}, '2026-07-14', '8.0000', 'approved', true, ${dept}, null, null, null, '{}'::jsonb)`)
    // USD is seeded by the currency-registry migration; the insert only
    // backfills it on databases seeded before that migration. A conflict is
    // therefore expected and benign: the row must exist, and we must never
    // overwrite the canonical name or minor units.
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD','2026-07-14'::date,'spot',1.35,'manual')`)
    for (const [num, sub, cur, amt] of [['HC-CAD', org.subsidiaryId, 'CAD', '100'], ['HC-USD', usSub, 'USD', '100']] as const) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, '2026-07-14', ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${sub}, ${dept}, ${amt}, ${cur}, ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${sub}, ${dept}, ${'-' + amt}, ${cur}, ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
  })
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await load(org.orgId)
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
  await withTrueCostOrg(
    { employees: [{ name: 'Unrated Worker', dept: 0, billable: false }] },
    async (seed) => {
      const data = await load(seed.org.orgId)
      assert.equal(data.labor.unratedHours, '8.0000')
      const timeCat = data.categories.find((c) => c.key === 'nonbillable_time')!
      assert.ok(timeCat, 'time category surfaces so the gap is named')
      assert.equal(timeCat.unratedHours, '8.0000')
      assert.equal(timeCat.totalAmount, 0)
    },
  )
})

/**
 * Untagged expense follows each category's own allocation base, and the
 * loader sends that exact split for the drawer: rent on headcount splits an
 * untagged 900 to 450/450 (never 800/100 by billed hours) while power on
 * square footage splits 100:300 to 225/675 with the matching deptShare —
 * a drawer defaulting to billed hours (8:1) would show the wrong share.
 */
test('true cost splits untagged expense by the category base and sends the drawer split', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  await withTrueCostOrg(
    {
      depts: ['Field A', 'Field B'],
      employees: [
        { name: 'Split A', dept: 0, rate: '50.0000' },
        { name: 'Split B', dept: 1, hours: '1.0000', rate: '50.0000' },
      ],
      burdenAccounts: [
        { ...RENT, match: { accountTypes: ['expense'], numberPrefixes: ['7850'] } },
        { number: '7855', name: 'Power', match: { accountTypes: ['expense'], numberPrefixes: ['7855'] } },
      ],
      journals: [rentJournal('SPLIT-1', '900', null), { entry: 'SPLIT-2', lines: [{ account: 1, dept: null, amount: '900' }, { account: 'bank', dept: null, amount: '-900' }] }],
      profile: {
        name: 'Split',
        categoryGroups: [{ group: 0, allocationBase: 'headcount' }, { group: 1, allocationBase: 'square_feet' }],
        baseOverridesByDept: { squareFeet: { 0: 100, 1: 300 } },
      },
    },
    async (seed) => {
      const data = await load(seed.org.orgId)
      const [deptA, deptB] = [seed.deptIds[0]!, seed.deptIds[1]!]
      const rent = data.categories.find((c) => c.key === 'rent')!
      assert.ok(rent, 'rent category present')
      assert.equal(rent.byDept[deptA]?.amount, 450)
      assert.equal(rent.byDept[deptB]?.amount, 450)
      const power = data.categories.find((c) => c.key === 'power')!
      assert.ok(power, 'power category present')
      assert.equal(power.byDept[deptA]?.amount, 225)
      assert.equal(power.byDept[deptB]?.amount, 675)
      // The drawer's split: square footage, not the 8:1 billed-hours ratio.
      assert.equal(power.deptShare[deptA], '0.2500')
      assert.equal(power.deptShare[deptB], '0.7500')
    },
  )
})
