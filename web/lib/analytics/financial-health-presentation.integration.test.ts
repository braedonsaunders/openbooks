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
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { financialHealth } = await import('./financial-health')

const D = '2026-07-14'
const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTranslatedOrg() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    await db.execute(sql`insert into consolidated_fx_rates (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', 1.35, 1.35, 1.3)`)
    // The prior-year comparison window translates through its own period's
    // set, so it needs one too (same rule as the formal statements).
    const calRow = await db.execute(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)
    const calRow0 = calRow.rows[0]
    if (!calRow0) throw new Error('scratch period has no fiscal calendar')
    const priorPeriod = randomUUID()
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${priorPeriod}, ${org.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31', false, ${String(calRow0.fiscal_calendar_id)})`)
    await db.execute(sql`insert into consolidated_fx_rates (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate)
      values (${org.orgId}, ${priorPeriod}, 'USD', 'CAD', 1.3, 1.3, 1.3)`)
    // Balanced entries: CAD revenue 100 / cogs 40 / bank 60 (Main) +
    // USD revenue 200 / cogs 100 / bank 100 (US).
    const legs = [
      ['PL-CAD', org.subsidiaryId, [[org.accounts.revenue, '-100', 'CAD'], [org.accounts.cogs, '40', 'CAD'], [org.accounts.bank, '60', 'CAD']]],
      ['PL-USD', usSub, [[org.accounts.revenue, '-200', 'USD'], [org.accounts.cogs, '100', 'USD'], [org.accounts.bank, '100', 'USD']]],
    ] as const
    for (const [label, sub, lines] of legs) {
      const entryId = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${label}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      let n = 0
      for (const [acct, amt, cur] of lines) {
        n += 1
        await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${randomUUID()}, ${org.orgId}, ${entryId}, ${n}, ${acct}, ${sub}, ${amt}, ${cur}, ${amt}, 1)`)
      }
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
    }
  })
  return org
}

/**
 * Financial health must render on a multi-currency consolidated org instead
 * of throwing the single-functional refusal: P&L flows translate at the
 * period average, balance-sheet stocks at the current rate, through the
 * statement matrix — the same numbers the formal statements report.
 */
test('financial health translates a multi-currency org through the matrix', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTranslatedOrg()
  try {
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const health = await financialHealth(P, undefined, org.orgId, null)
        const ratio = (cat: string, id: string) =>
          (health.ratios as unknown as Record<string, { id: string; value: number | null }[]>)[cat]!.find((r) => r.id === id)!.value
        // Revenue 100 + 200×1.35 = 370; operating expense 40 + 100×1.35
        // = 175 (the scratch COGS account carries type expense, exactly as
        // the refusing reader classifies it); assets 60 + 100×1.35 = 195.
        assert.equal(health.figures.revenue, 370)
        assert.equal(health.figures.opex, 175)
        assert.equal(health.figures.totalAssets, 195)
        assert.ok(Math.abs((ratio('efficiency', 'asset_turnover') ?? 0) - 370 / 195) < 1e-9)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
