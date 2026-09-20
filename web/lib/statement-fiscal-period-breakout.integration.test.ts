import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Statement month/quarter breakouts must follow the org's configured fiscal
 * periods for retail calendars — not calendar months. A 4-4-5 org's 5-week
 * period is ONE column (labelled with the fiscal period name) even when it
 * straddles two calendar months, and quarter columns group the calendar's
 * declared periods. Monthly-cadence orgs (January or April start) must stay
 * byte-identical to calendar math.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { generateAccountingPeriods } = (await import(root + 'engine/src/close/close.ts')) as typeof import('@openbooks/engine/src/close/close.ts')
const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')
const { resolvePeriod } = (await import(root + 'web/lib/periods.ts')) as typeof import('./periods')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

/** Post revenue `amount` on `date` (bank debit / revenue credit, like the
 *  quarter-breakout fixture). Entries are uniquely numbered per call. */
async function postRevenue(org: ScratchOrg, calendarId: string, date: string, amount: string): Promise<void> {
  const periodId = (
    await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${org.orgId} and fiscal_calendar_id = ${calendarId}
         and not is_adjustment and starts_on <= ${date} and ${date} <= ends_on
       limit 1`)
  ).rows[0]?.id
  assert.ok(periodId, `no fiscal period covers ${date}`)
  const entry = randomUUID()
  const memo = `W09-${date}-${entry.slice(0, 8)}`
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${memo}, ${date}, ${periodId}, ${memo}, 'draft', 'manual')`)
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
           (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
}

async function revenueValues(matrix: Awaited<ReturnType<typeof statementMatrix>>, width: number): Promise<string[]> {
  const revenue = matrix.rows.find((r) => r.type === 'income')
  assert.ok(revenue, 'expected a revenue row')
  return revenue.values.slice(0, width).map(String)
}

/**
 * Scratch org converted to a 4-4-5 retail calendar: the monthly default is
 * retired and FY2026 is generated from a Monday 2026-02-02 anchor, giving
 * P01 02-02..03-01 (4w), P02 03-02..03-29 (4w), P03 03-30..05-03 (5w),
 * P04 05-04..05-31 (4w), … P12 ending 2027-01-31.
 */
async function release445Org(org: ScratchOrg, calendarId: string, baselineCalendarId: string) {
  // Undo the default switch before release: the fixture reset restores
  // baseline calendar rows in place, and a surviving second default trips
  // fiscal_calendars_one_default, tainting the lease. Retail off first so
  // two defaults never coexist; the baseline row then re-arms exactly.
  await withBypassContext(() => db.execute(sql`update fiscal_calendars set is_default = false where id = ${calendarId} and org_id = ${org.orgId}`))
  await withBypassContext(() => db.execute(sql`update fiscal_calendars set is_default = true where id = ${baselineCalendarId} and org_id = ${org.orgId}`))
  await withBypassContext(() => dropScratchOrg(org.orgId))
}

async function make445Org(): Promise<{ org: ScratchOrg; calendarId: string; baselineCalendarId: string }> {
  const org = await withBypassContext(() => createScratchOrg())
  const baselineCalendarId = await withBypassContext(async () => {
    const row = (await db.execute<{ id: string }>(sql`select id from fiscal_calendars where org_id = ${org.orgId} and is_default`)).rows[0]
    assert.ok(row, 'expected a baseline default calendar')
    return row.id
  })
  const calendarId = await withBypassContext(async () => {
    const id = randomUUID()
    await db.execute(sql`update fiscal_calendars set is_default = false where org_id = ${org.orgId} and is_default`)
    await db.execute(sql`insert into fiscal_calendars
      (id, org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone, is_default, is_active, config)
      values (${id}, ${org.orgId}, 'Retail 4-4-5', 'four_four_five', 2, 1, '2026-02-02', 'UTC', true, true, '{"anchorFiscalYear": 2026}'::jsonb)`)
    await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 2}'::jsonb where id = ${org.orgId}`)
    const actorId = await createScratchUser(org.orgId, 'Calendar keeper', 'admin')
    const generated = await generateAccountingPeriods(org.orgId, id, 2026, actorId)
    assert.equal(generated.periods.length, 12)
    assert.deepEqual(
      generated.periods.slice(0, 4).map((p) => [p.number, p.startsOn, p.endsOn]),
      [
        [1, '2026-02-02', '2026-03-01'],
        [2, '2026-03-02', '2026-03-29'],
        [3, '2026-03-30', '2026-05-03'],
        [4, '2026-05-04', '2026-05-31'],
      ],
    )
    return id
  })
  return { org, calendarId, baselineCalendarId }
}

test('month breakout follows 4-4-5 fiscal periods; a 5-week period is one column', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, calendarId, baselineCalendarId } = await make445Org()
  try {
    await withBypassContext(async () => {
      // Mar 31 and Apr 15 both fall in the 5-week P03 (03-30..05-03):
      // calendar math would split them across March/April columns.
      await postRevenue(org, calendarId, '2026-02-10', '400.0000')
      await postRevenue(org, calendarId, '2026-03-31', '100.0000')
      await postRevenue(org, calendarId, '2026-04-15', '200.0000')
      await postRevenue(org, calendarId, '2026-05-10', '500.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-02-02', to: '2026-05-31' },
        periodLabel: 'Q1 4-4-5',
        breakout: 'month',
      })
      assert.deepEqual(
        matrix.columns.map((c) => [c.label, c.from, c.to]),
        [
          ['P01 FY2026', '2026-02-02', '2026-03-01'],
          ['P02 FY2026', '2026-03-02', '2026-03-29'],
          ['P03 FY2026', '2026-03-30', '2026-05-03'],
          ['P04 FY2026', '2026-05-04', '2026-05-31'],
        ],
      )
      assert.deepEqual(await revenueValues(matrix, 4), ['400.0000', '0.0000', '300.0000', '500.0000'])
    })
  } finally {
    await release445Org(org, calendarId, baselineCalendarId)
  }
})

test('quarter breakout groups the 4-4-5 calendar declared periods', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, calendarId, baselineCalendarId } = await make445Org()
  try {
    await withBypassContext(async () => {
      await postRevenue(org, calendarId, '2026-02-10', '400.0000')
      await postRevenue(org, calendarId, '2026-03-31', '100.0000')
      await postRevenue(org, calendarId, '2026-04-15', '200.0000')
      await postRevenue(org, calendarId, '2026-05-10', '500.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-02-02', to: '2026-05-31' },
        periodLabel: 'Q1–Q2 4-4-5',
        breakout: 'quarter',
      })
      assert.deepEqual(
        matrix.columns.map((c) => [c.label, c.from, c.to]),
        [
          ['Q1 FY 2026', '2026-02-02', '2026-05-03'],
          // Q2 spans the full known group (P04–P06 generated for FY2026),
          // like a calendar quarter spans its full bounds.
          ['Q2 FY 2026', '2026-05-04', '2026-08-02'],
        ],
      )
      assert.deepEqual(await revenueValues(matrix, 2), ['700.0000', '500.0000'])
    })
  } finally {
    await release445Org(org, calendarId, baselineCalendarId)
  }
})

test('month breakout falls back to calendar math past generated periods', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Fail-safe gate: FY2027 was never generated for this calendar, so a
  // window reaching past FY2026 must keep the old calendar columns rather
  // than silently dropping activity outside declared periods.
  const { org, calendarId, baselineCalendarId } = await make445Org()
  try {
    await withBypassContext(async () => {
      await postRevenue(org, calendarId, '2026-04-15', '200.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-02-02', to: '2027-06-30' },
        periodLabel: 'spillover',
        breakout: 'month',
      })
      assert.equal(matrix.columns.length, 17)
      assert.equal(matrix.columns[0]!.label, '2026-02')
      assert.equal(matrix.columns[2]!.label, '2026-04')
      assert.deepEqual(await revenueValues(matrix, 17).then((v) => [v[0], v[2]]), ['0.0000', '200.0000'])
    })
  } finally {
    await release445Org(org, calendarId, baselineCalendarId)
  }
})

test('monthly January-start orgs keep calendar-month breakouts byte-identical', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const calendarId: string = await withBypassContext(async () => {
      const id = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
      for (const [n, from, to] of [['2026-01', '2026-01-01', '2026-01-31'], ['2026-02', '2026-02-01', '2026-02-28'], ['2026-03', '2026-03-01', '2026-03-31']] as const) {
        await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, 2026, ${Number(n.slice(5))}, ${n}, ${from}, ${to}, false, ${id})`)
      }
      await postRevenue(org, id, '2026-01-15', '100.0000')
      await postRevenue(org, id, '2026-02-15', '200.0000')
      await postRevenue(org, id, '2026-03-15', '300.0000')
      return id
    })
    assert.ok(calendarId)
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-01-01', to: '2026-03-31' },
        periodLabel: 'Q1 2026',
        breakout: 'month',
      })
      assert.deepEqual(
        matrix.columns.map((c) => [c.label, c.from, c.to]),
        [
          ['2026-01', '2026-01-01', '2026-01-31'],
          ['2026-02', '2026-02-01', '2026-02-28'],
          ['2026-03', '2026-03-01', '2026-03-31'],
        ],
      )
      assert.deepEqual(await revenueValues(matrix, 3), ['100.0000', '200.0000', '300.0000'])
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('monthly April-start orgs keep fiscal quarter breakouts byte-identical', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 4}'::jsonb where id = ${org.orgId}`)
      const calendarId = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
      for (const [n, from, to] of [[1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [5, '2026-05-01', '2026-05-31']] as const) {
        await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, 2026, ${n}, ${'2026-' + String(n).padStart(2, '0')}, ${from}, ${to}, false, ${calendarId})`)
      }
      await postRevenue(org, calendarId, '2026-01-15', '100.0000')
      await postRevenue(org, calendarId, '2026-05-15', '200.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-01-01', to: '2026-06-30' },
        periodLabel: 'H1',
        breakout: 'quarter',
      })
      assert.deepEqual(
        matrix.columns.map((c) => [c.label, c.from, c.to]),
        [
          ['Q4 FY 2026', '2026-01-01', '2026-03-31'],
          ['Q1 FY 2027', '2026-04-01', '2026-06-30'],
        ],
      )
      assert.deepEqual(await revenueValues(matrix, 2), ['100.0000', '200.0000'])
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('period presets agree with fiscal periods on a 4-4-5 org', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, calendarId, baselineCalendarId } = await make445Org()
  try {
    await withOrgContext(org.orgId, async () => {
      const today = '2026-04-15' // inside the 5-week P03
      assert.deepEqual(await resolvePeriod('this_period', { today, orgId: org.orgId }), {
        presetId: 'this_period',
        from: '2026-03-30',
        to: '2026-05-03',
        label: 'P03 FY2026',
      })
      assert.deepEqual(await resolvePeriod('this_month', { today, orgId: org.orgId }), {
        presetId: 'this_month',
        from: '2026-03-30',
        to: '2026-05-03',
        label: 'P03 FY2026',
      })
      assert.deepEqual(await resolvePeriod('last_period', { today, orgId: org.orgId }), {
        presetId: 'last_period',
        from: '2026-03-02',
        to: '2026-03-29',
        label: 'P02 FY2026',
      })
      assert.deepEqual(await resolvePeriod('this_fiscal_quarter', { today, orgId: org.orgId }), {
        presetId: 'this_fiscal_quarter',
        from: '2026-02-02',
        to: '2026-05-03',
        label: 'Q1 FY 2026',
      })
      assert.deepEqual(await resolvePeriod('this_fiscal_year', { today, orgId: org.orgId }), {
        presetId: 'this_fiscal_year',
        from: '2026-02-02',
        to: '2027-01-31',
        label: 'FY 2026',
      })
    })
  } finally {
    await release445Org(org, calendarId, baselineCalendarId)
  }
})
