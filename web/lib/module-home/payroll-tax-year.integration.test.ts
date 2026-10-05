import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { toUnits } = await import('@openbooks/engine/src/money/money.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { payrollHome } = await import('./payroll.ts')

const DB = !!env.OPENBOOKS_DB_URL

// The payroll tax year is a pack property (HMRC's 6 April), never the
// calendar year: in February 2026 a GB org is still in tax year 2025, and
// the YTD/run counts must follow the pack there instead of silently
// splitting one statutory year across two calendar years.
test('the tax year follows the installed pack, not the calendar', { skip: !DB }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"payroll": {"countries": ["GB"]}}'::jsonb
         where id = ${scratch.orgId}`)
    })
    const home = await pinClock('2026-02-15', () => withBypass(() => payrollHome(scratch.orgId, null)))
    assert.equal(home.taxYear, 2025, 'February 2026 is still GB tax year 2025')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

// YTD stubs in different currencies are translated at their pay-date spot
// before adding — a USD 100 stub at 1.50 joins CAD 1000 as 150, never 100.
test('YTD totals translate per-currency stubs instead of raw-adding them', { skip: !DB }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Payroll clerk', 'admin'))
  const today = new Date().toISOString().slice(0, 10)
  const year = Number(today.slice(0, 4))
  try {
    const documentId = randomUUID()
    const scheduleId = randomUUID()
    const cadParty = randomUUID()
    const usdParty = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${scratch.orgId}, 'USD', 'CAD', ${today}::date, 'spot', 1.5, 'manual')`)
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${scratch.orgId}, 'Biweekly', 'biweekly', 26, '2026-06-28', 3, true,
                ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date, currency, status, created_by, updated_by)
        values (${scratch.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
                ${scratch.subsidiaryId}, ${today}, 'CAD', 'approved', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status, calculated_at, created_by, updated_by)
        values (${documentId}, ${scratch.orgId}, ${scheduleId}, ${today}, ${today}, ${today}, ${year}, 'committed', now(), ${actorId}, ${actorId})`)
      for (const [party, currency, gross] of [[cadParty, 'CAD', '1000'], [usdParty, 'USD', '100']] as const) {
        await db.execute(sql`
          insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id,
                                 province, periods_per_year, pay_date, tax_year, currency_code,
                                 gross, net_pay, employer_cost, created_by, updated_by)
          values (${randomUUID()}, ${scratch.orgId}, ${documentId}, ${party}, ${party},
                  'ON', 26, ${today}, ${year}, ${currency},
                  ${gross}, ${gross}, '0', ${actorId}, ${actorId})`)
      }
    })
    const home = await withBypass(() => payrollHome(scratch.orgId, null))
    assert.equal(toUnits(home.ytdGross), toUnits('1150'), 'USD 100 at 1.50 joins CAD 1000 as 150')
    assert.equal(toUnits(home.ytdNet), toUnits('1150'))
    assert.equal(home.runsThisYear, 1)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
