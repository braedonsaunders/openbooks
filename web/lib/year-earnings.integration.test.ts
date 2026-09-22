import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { balanceSheetView } = await import('./statement-matrix.ts')
const { balanceSheet, trialBalance } = await import('./reports/statements.ts')
const { generalLedger } = await import('./reports/ledger-reports.ts')
const { decimalAdd, decimalIsZero } = await import('./statement-format.ts')
const {
  COMPUTED_CURRENT_YEAR_EARNINGS_ID,
  COMPUTED_RETAINED_EARNINGS_PRIOR_ID,
} = await import('./computed-earnings.ts')

const labels = {
  assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
  totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', totalEquity: 'Total equity',
  retainedEarningsPrior: 'Retained earnings (prior years)',
  currentYearEarnings: 'Current year earnings',
  translationAdjustment: 'Translation adjustment',
  liabilitiesAndEquity: 'Liabilities and equity',
  totalOf: (s: string) => `Total ${s}`,
}

async function fiscalCalendarId(orgId: string, periodId: string): Promise<string> {
  const row = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods
     where id = ${periodId} and org_id = ${orgId}`)).rows[0]
  assert.ok(row, 'scratch period has a fiscal calendar')
  return row.fiscal_calendar_id
}

async function insertPeriod(args: {
  orgId: string
  calendarId: string
  year: number
  number: number
  name: string
  from: string
  to: string
}): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
    values (${id}, ${args.orgId}, ${args.calendarId}, ${args.year}, ${args.number},
            ${args.name}, ${args.from}, ${args.to}, false)`)
  return id
}

async function post(args: {
  orgId: string
  bookId: string
  subsidiaryId: string
  periodId: string
  date: string
  debit: string
  credit: string
  amount: string
  tag: string
}): Promise<void> {
  const entry = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${args.orgId}, ${args.bookId}, ${args.subsidiaryId},
            ${args.tag}, ${args.date}, ${args.periodId}, ${args.tag}, 'draft', 'manual')`)
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${args.orgId}, ${entry}, 1, ${args.debit}, ${args.subsidiaryId}, ${args.amount}, 'CAD', ${args.amount}, '1'),
           (${args.orgId}, ${entry}, 2, ${args.credit}, ${args.subsidiaryId}, ${`-${args.amount}`}, 'CAD', ${`-${args.amount}`}, '1')`)
  // Runs in the caller's bypass scope, NOT a nested withBypassContext: the
  // inserts above inherit the outer withBypass, and opening a second
  // mechanism inside it lost the scope, so this UPDATE matched zero rows.
  // RLS filters an UPDATE, it does not raise — so the seed silently left
  // every entry in 'draft' and the statements correctly reported nothing.
  // Asserting the row count is what turns that back into a failure.
  const posted = await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now()
     where id = ${entry} returning id`)
  assert.equal(posted.rows.length, 1, `seed failed to post entry ${args.tag}`)
}

function findLine(view: Awaited<ReturnType<typeof balanceSheetView>>, label: string) {
  const line = view.lines.find((row) => row.label === label)
  assert.ok(line, `missing ${label}`)
  return line
}

test('year-aware earnings split prior-year P&L from FYTD on BS, TB, and GL', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      const calendarId = await fiscalCalendarId(scratch.orgId, scratch.periodId)
      const priorPeriodId = await insertPeriod({
        orgId: scratch.orgId, calendarId, year: 2025, number: 12,
        name: '2025-12', from: '2025-12-01', to: '2025-12-31',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: priorPeriodId, date: '2025-12-15',
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '80.0000', tag: 'YE-PRIOR',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: scratch.periodId, date: scratch.date,
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '25.0000', tag: 'YE-CURRENT',
      })
    })

    const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
    const prior = bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)
    const current = bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)
    assert.equal(prior?.balance, '80.0000')
    assert.equal(current?.balance, '25.0000')
    assert.equal(bs.totalEquity, decimalAdd(prior!.balance, current!.balance))

    const view = await withBypassContext(() => balanceSheetView(
      { from: '2026-07-01', to: scratch.date }, 'July 2026', labels, { orgId: scratch.orgId },
    ))
    const priorLine = findLine(view, 'Retained earnings (prior years)')
    const currentLine = findLine(view, 'Current year earnings')
    assert.equal(priorLine.values?.[0], '80.0000')
    assert.equal(currentLine.values?.[0], '25.0000')
    assert.deepEqual(priorLine.drillWindows?.[0], {
      from: null, to: '2025-12-31', mode: 'balance',
    })
    assert.deepEqual(currentLine.drillWindows?.[0], {
      from: '2026-01-01', to: scratch.date, mode: 'flow',
    })

    const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
    const tbRevenue = tb.find((row) => row.id === scratch.accounts.revenue)
    const tbPrior = tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)
    assert.equal(tbRevenue?.balance, '-25.0000')
    assert.equal(tbRevenue?.credits, '25.0000')
    assert.ok(tbPrior, 'prior-year RE placeholder appears once prior-year P&L exists')
    assert.equal(tbPrior.credits, '80.0000')
    assert.equal(tbPrior.balance, '-80.0000')
    const tbSum = tb.reduce((sum, row) => decimalAdd(sum, row.balance), '0.0000')
    assert.ok(decimalIsZero(tbSum), `trial balance must foot, got ${tbSum}`)
    const tbDebits = tb.reduce((sum, row) => decimalAdd(sum, row.debits), '0.0000')
    const tbCredits = tb.reduce((sum, row) => decimalAdd(sum, row.credits), '0.0000')
    assert.equal(tbDebits, tbCredits)

    const gl = await withBypassContext(() =>
      generalLedger('2026-07-01', scratch.date, { orgId: scratch.orgId, accountId: scratch.accounts.revenue }),
    )
    const glRevenue = gl.accounts.find((row) => row.id === scratch.accounts.revenue)
    assert.equal(glRevenue?.opening, '0.0000', 'P&L opening is FY start, not lifetime')
    assert.equal(glRevenue?.closing, '-25.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('first fiscal year has zero prior earnings and an unwindowed trial balance', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: scratch.periodId, date: scratch.date,
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '40.0000', tag: 'YE-FIRST',
      })
    })
    const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '0.0000')
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '40.0000')

    const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
    assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID), undefined)
    assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-40.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('July fiscal year start splits June activity into prior-year earnings', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 7}'::jsonb
         where id = ${scratch.orgId}`)
      const calendarId = await fiscalCalendarId(scratch.orgId, scratch.periodId)
      const juneId = await insertPeriod({
        orgId: scratch.orgId, calendarId, year: 2026, number: 6,
        name: '2026-06', from: '2026-06-01', to: '2026-06-30',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: juneId, date: '2026-06-15',
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '15.0000', tag: 'YE-JUNE',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: scratch.periodId, date: scratch.date,
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '9.0000', tag: 'YE-JULY',
      })
    })
    const bs = await withBypassContext(() => balanceSheet(scratch.date, scratch.orgId))
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '15.0000')
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '9.0000')
    const tb = await withBypassContext(() => trialBalance(scratch.date, undefined, scratch.orgId))
    assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-9.0000')
    assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.credits, '15.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('a 4-4-5 year starting off-month splits boundary P&L on the declared boundary', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      // Retail calendar: FY2027 starts Saturday 2026-07-05, mid-month.
      // Calendar-month math (FY start 2026-01-01) would put both postings in
      // the current year; the declared boundary puts 07-01 in the prior year.
      const fixtureCalendar = await fiscalCalendarId(scratch.orgId, scratch.periodId)
      await db.execute(sql`
        update fiscal_calendars set is_default = false where id = ${fixtureCalendar}`)
      const calendarId = randomUUID()
      await db.execute(sql`
        insert into fiscal_calendars
          (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
           adjustment_period_enabled, is_default, is_active, config)
        values (${calendarId}, ${scratch.orgId}, 'Retail 4-4-5', 'four_four_five',
                7, 6, 'UTC', false, true, true, '{}'::jsonb)`)
      const priorPeriodId = await insertPeriod({
        orgId: scratch.orgId, calendarId, year: 2026, number: 12,
        name: 'FY2026-P12', from: '2026-06-28', to: '2026-07-04',
      })
      const currentPeriodId = await insertPeriod({
        orgId: scratch.orgId, calendarId, year: 2027, number: 1,
        name: 'FY2027-P01', from: '2026-07-05', to: '2026-08-01',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: priorPeriodId, date: '2026-07-01',
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '80.0000', tag: 'YE-445-PRIOR',
      })
      await post({
        orgId: scratch.orgId, bookId: scratch.bookId, subsidiaryId: scratch.subsidiaryId,
        periodId: currentPeriodId, date: '2026-07-10',
        debit: scratch.accounts.bank, credit: scratch.accounts.revenue,
        amount: '25.0000', tag: 'YE-445-CURRENT',
      })
    })

    const bs = await withBypassContext(() => balanceSheet('2026-07-15', scratch.orgId))
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.balance, '80.0000')
    assert.equal(bs.equity.find((row) => row.id === COMPUTED_CURRENT_YEAR_EARNINGS_ID)?.balance, '25.0000')

    const tb = await withBypassContext(() => trialBalance('2026-07-15', undefined, scratch.orgId))
    assert.equal(tb.find((row) => row.id === scratch.accounts.revenue)?.balance, '-25.0000')
    assert.equal(tb.find((row) => row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID)?.credits, '80.0000')

    const view = await withBypassContext(() => balanceSheetView(
      { from: '2026-07-01', to: '2026-07-15' }, 'July 2026', labels, { orgId: scratch.orgId },
    ))
    assert.equal(findLine(view, 'Retained earnings (prior years)').values?.[0], '80.0000')
    assert.equal(findLine(view, 'Current year earnings').values?.[0], '25.0000')
    assert.deepEqual(findLine(view, 'Retained earnings (prior years)').drillWindows?.[0], {
      from: null, to: '2026-07-04', mode: 'balance',
    })
    assert.deepEqual(findLine(view, 'Current year earnings').drillWindows?.[0], {
      from: '2026-07-05', to: '2026-07-15', mode: 'flow',
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
