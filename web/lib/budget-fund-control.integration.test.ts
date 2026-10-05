import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Budgetary control matches an approved budget cell on its exact dimensions,
 * fund included. The budget worksheet's own writer must store a cell the
 * control can find: a fund-controlled cell budgeted through saveBudgetCells
 * admits spending within it and refuses spending beyond it, and a line saved
 * before fund accounting (no fund) reads as the default fund's appropriation.
 */
const root = pathToFileURL(process.cwd() + '/').href
const { db, withBypass, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { provisionFundAccounting } = (await import(root + 'engine/src/nonprofit/provision.ts')) as typeof import('@openbooks/engine/src/nonprofit/provision.ts')
const { budgetaryControlProvider } = (await import(root + 'engine/src/nonprofit/encumbrances.ts')) as typeof import('@openbooks/engine/src/nonprofit/encumbrances.ts')
const { NonprofitPostingError } = (await import(root + 'engine/src/nonprofit/errors.ts')) as typeof import('@openbooks/engine/src/nonprofit/errors.ts')
const { installEngineSeams } = (await import(root + 'engine/src/composition/install.ts')) as typeof import('@openbooks/engine/src/composition/install.ts')
const { clearBalancingLegProviders, registerBalancingLegProvider } = (await import(root + 'engine/src/journal/balancing-hooks.ts')) as typeof import('@openbooks/engine/src/journal/balancing-hooks.ts')
const { postEntry } = (await import(root + 'engine/src/journal/post-entry.ts')) as typeof import('@openbooks/engine/src/journal/post-entry.ts')
const { saveBudgetCells } = (await import(root + 'web/lib/budget-mutations.ts')) as typeof import('./budget-mutations')

test('a budget saved through the worksheet writer is the cell fund control enforces', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  clearBalancingLegProviders()
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, 'Budget Controller', 'admin'))
    await withOrgContext(org.orgId, () => db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true,"budgets":true,"encumbrances":true}'::jsonb, true)
       where id = ${org.orgId}`))
    const { defaultFundId } = await provisionFundAccounting({
      orgId: org.orgId, defaultFund: { code: 'OPERATING', name: 'Operating Fund' },
      classifications: { OPERATING: { kind: 'operating', restrictionClass: 'without_donor_restrictions' } }, actorId,
    })
    await withOrgContext(org.orgId, () => db.execute(sql`
      update funds set budgetary_control = 'hard' where org_id = ${org.orgId} and id = ${defaultFundId}`))
    const scenarioId = randomUUID()
    const year = (await withOrgContext(org.orgId, () => db.execute<{ fiscal_year: number }>(sql`
      select fiscal_year from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`))).rows[0]!.fiscal_year
    await withBypassContext(() => db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${year}, 'Operating plan', 'budget', 'draft', ${actorId}, ${actorId})`))
    // The worksheet writer, with no fund chosen: the cell is stored under the default fund.
    await withOrgContext(org.orgId, () => saveBudgetCells({
      scenarioId, orgId: org.orgId, actorId, expectedRevision: 1,
      cells: [{ accountId: org.accounts.cogs, periodId: org.periodId, subsidiaryId: org.subsidiaryId,
        departmentId: null, projectId: null, locationId: null, classId: null, amount: '100.0000' }],
    }))
    const stored = await withOrgContext(org.orgId, () => db.execute<{ extra_dims: Record<string, string> }>(sql`
      select extra_dims from budget_lines where org_id = ${org.orgId} and scenario_id = ${scenarioId}`))
    assert.deepEqual(stored.rows.map((row) => row.extra_dims), [{ fund: defaultFundId }])
    // A line saved before fund accounting names no fund and still counts, as the default fund.
    await withBypassContext(() => db.execute(sql`
      insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.adjustment}, ${org.periodId}, ${org.subsidiaryId}, '10.0000', ${actorId}, ${actorId})`))
    await withBypassContext(() => db.execute(sql`
      update budget_scenarios set status = 'pending_approval', revision = revision + 1, submitted_at = now(), submitted_by = ${actorId}
       where id = ${scenarioId} and org_id = ${org.orgId}`))
    await withBypassContext(() => db.execute(sql`
      update budget_scenarios set status = 'approved', revision = revision + 1, approved_at = now(), approved_by = ${actorId}
       where id = ${scenarioId} and org_id = ${org.orgId}`))
    installEngineSeams()
    registerBalancingLegProvider('budgetary-control', budgetaryControlProvider)
    const post = (account: string, amount: string) => withOrgContext(org.orgId, () => db.transaction((tx) => postEntry(tx, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `FUND-CONTROL-${randomUUID()}`,
      postingDate: org.date, periodId: org.periodId, origin: 'manual', currency: 'CAD',
      lines: [
        { accountId: account, amount, subsidiaryId: org.subsidiaryId, currency: 'CAD' },
        { accountId: org.accounts.bank, amount: '-' + amount, subsidiaryId: org.subsidiaryId, currency: 'CAD' },
      ],
    })))
    assert.equal((await post(org.accounts.cogs, '50.0000')).lines.length, 2, 'spending within the saved budget posts')
    assert.equal((await post(org.accounts.adjustment, '10.0000')).lines.length, 2, 'a fund-less budget line is the default fund appropriation')
    await assert.rejects(post(org.accounts.cogs, '50.0100'), (error) =>
      error instanceof NonprofitPostingError && error.code === 'budget_exceeded' && error.message.includes('0.0100') &&
      error.remedy.includes('copy the approved budget to a draft'))
  } finally {
    clearBalancingLegProviders()
    await dropScratchOrg(org.orgId)
  }
})
