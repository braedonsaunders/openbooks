import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { mulDecimal, mulRatio } = await import('@openbooks/engine/src/money/money.ts')
const { financialHealth } = await import('./financial-health')
const { saveRatioInput } = await import('./ratio-inputs')
const { decimalRatio } = await import('../reports/decimals')

/**
 * The ratio engine derives every input it does not have from the books or
 * from the organization's own setup, and refuses by name otherwise:
 * - NOPAT is taxed at the effective rate the period actually booked, else at
 *   the statutory rate from tax setup, else ROIC is refused — never 25%;
 * - interest and debt come only from the accounts the organization
 *   classified; an unclassified chart refuses rather than guessing from
 *   account types (a long-term deferred tax balance is not debt);
 * - no revenue means no margin, never a grade A on a cost ratio;
 * - liquidity reads the balance-sheet account types.
 */

const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function account(org: Org, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`insert into accounts(id, org_id, number, name, type) values (${id}, ${org.orgId}, ${number}, ${name}, ${type})`)
  return id
}

/** Post one balanced two-line entry: debit `dr`, credit `cr`. */
async function post(org: Org, dr: string, cr: string, amount: string): Promise<void> {
  const entry = randomUUID()
  await db.execute(sql`insert into journal_entries(id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry}, ${org.date}, ${org.periodId}, 'draft', 'manual')`)
  await db.execute(sql`insert into journal_lines(org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${org.orgId}, ${entry}, 1, ${dr}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1),
           (${org.orgId}, ${entry}, 2, ${cr}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, 1)`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
}

interface Seeded {
  org: Org
  admin: string
  interest: string
  tax: string
  loan: string
  deferredTax: string
}

/**
 * Revenue 1000, COGS 400, operating expense 200 (on account), interest 50,
 * income tax 70: operating income 400, net income 280, pre-tax 350 — an
 * effective rate of 20%. Capital 10000, a 5000 loan and a 1000 deferred tax
 * balance, both long-term liabilities.
 */
async function seed(options: { tax: boolean }): Promise<Seeded> {
  const org = await withBypass(() => createScratchOrg())
  const ids = await withBypass(async () => {
    const equity = await account(org, '3000', 'Share capital', 'equity')
    const opex = await account(org, '6000', 'Operating costs', 'expense')
    const interest = await account(org, '7100', 'Bank charges and loan costs', 'expense_other')
    const tax = await account(org, '7900', 'Tax on profits', 'expense_other')
    const loan = await account(org, '2500', 'Term facility', 'liability_long_term')
    const deferredTax = await account(org, '2600', 'Deferred tax', 'liability_long_term')
    await post(org, org.accounts.bank, equity, '10000')
    await post(org, org.accounts.bank, loan, '5000')
    await post(org, org.accounts.bank, deferredTax, '1000')
    await post(org, org.accounts.ar, org.accounts.revenue, '1000')
    await post(org, org.accounts.cogs, org.accounts.bank, '400')
    await post(org, opex, org.accounts.ap, '200')
    await post(org, interest, org.accounts.bank, '50')
    if (options.tax) await post(org, tax, org.accounts.bank, '70')
    const admin = await createScratchUser(org.orgId, 'Controller', 'admin')
    return { interest, tax, loan, deferredTax, admin }
  })
  return { org, ...ids }
}

const ratio = (health: Awaited<ReturnType<typeof financialHealth>>, id: string) =>
  Object.values(health.ratios).flat().find((r) => r.id === id)!

test('an unclassified chart refuses the leverage ratios by name instead of guessing from account types', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seed({ tax: true })
  try {
    await withOrgContext(org.orgId, async () => {
      const health = await financialHealth(P, org.orgId, null)
      for (const id of ['interest_coverage', 'debt_to_equity', 'roic']) {
        const r = ratio(health, id)
        assert.equal(r.value, null, `${id} has no value until the organization classifies its accounts`)
        assert.match(r.unavailable ?? '', /Financial Health → Configuration/, `${id} names where to classify`)
        assert.equal(r.grade, null)
      }
      // A ratio that needs no classification is still computed.
      assert.equal(ratio(health, 'roce').unavailable, null)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('ROIC taxes NOPAT at the effective rate the books carry, over classified debt only', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, admin, interest, tax, loan } = await seed({ tax: true })
  try {
    await withBypass(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,incomeTaxExpense}', to_jsonb(${tax}::text), true) where id = ${org.orgId}`)
      await saveRatioInput(org.orgId, admin, 'interest_expense', [interest], 'Interest expense')
      await saveRatioInput(org.orgId, admin, 'interest_bearing_debt', [loan], 'Interest-bearing debt')
    })
    await withOrgContext(org.orgId, async () => {
      const health = await financialHealth(P, org.orgId, null)
      assert.equal(health.figures.operatingIncome, '400.0000')
      assert.equal(health.figures.incomeTaxExpense, '70.0000')
      assert.equal(health.figures.preTaxIncome, '350.0000')
      assert.equal(health.figures.interestBearingDebt, '5000.0000', 'the deferred tax balance is not debt')

      assert.equal(ratio(health, 'interest_coverage').value, '8.0000')

      const roic = ratio(health, 'roic')
      const nopat = mulDecimal(mulRatio('400.0000', BigInt(health.period.fiscalYearDays), BigInt(health.period.days)), '0.8000')
      assert.equal(roic.value, decimalRatio(nopat, health.figures.investedCapital!), 'operating income × (1 − 70/350), annualized, over equity + the loan')
      assert.match(roic.basis ?? '', /effective tax rate 20%/)
      assert.ok(!/25/.test(roic.basis ?? ''), 'no assumed rate appears')

      assert.equal(ratio(health, 'debt_to_equity').value, decimalRatio('5000.0000', health.figures.totalEquity))
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('with no tax booked ROIC uses the statutory rate from tax setup, and refuses without one', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, admin, loan } = await seed({ tax: false })
  try {
    await withBypass(() => saveRatioInput(org.orgId, admin, 'interest_bearing_debt', [loan], 'Interest-bearing debt'))
    await withOrgContext(org.orgId, async () => {
      const refused = ratio(await financialHealth(P, org.orgId, null), 'roic')
      assert.equal(refused.value, null)
      assert.match(refused.unavailable ?? '', /Income tax rates/, 'the refusal names the setup that would answer it')
    })
    await withBypass(() => db.execute(sql`insert into income_tax_rates(org_id, jurisdiction, rate_percent, effective_from)
      values (${org.orgId}, 'FED', '15.0000', '2026-01-01')`))
    await withOrgContext(org.orgId, async () => {
      const roic = ratio(await financialHealth(P, org.orgId, null), 'roic')
      assert.notEqual(roic.value, null)
      assert.match(roic.basis ?? '', /statutory tax rate 15%/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('liquidity reads balance-sheet account types, and no revenue never grades a cost ratio', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seed({ tax: true })
  try {
    await withOrgContext(org.orgId, async () => {
      const health = await financialHealth(P, org.orgId, null)
      assert.equal(ratio(health, 'current_ratio').value, decimalRatio(health.figures.currentAssets, '200.0000'), 'AP is the only current liability')
      assert.equal(ratio(health, 'working_capital').value, health.figures.workingCapital)

      // A month with no activity at all: margins and cost ratios are unavailable, not A.
      const empty = await financialHealth({ from: '2026-09-01', to: '2026-09-30', label: 'September 2026' }, org.orgId, null)
      for (const id of ['gross_margin', 'cogs_ratio', 'opex_ratio']) {
        const r = ratio(empty, id)
        assert.equal(r.value, null)
        assert.equal(r.grade, null, `${id} is not graded without revenue`)
        assert.match(r.unavailable ?? '', /No revenue/)
      }
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
