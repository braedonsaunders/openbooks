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
const { bankBalances } = await import('./core.ts')

/**
 * Bank balances are cash stated in the org's presentation currency: a USD 100
 * balance at a 1.35 closing spot is 135 CAD of cash, not 100. The reader sums
 * whole months from the gl_month_activity summary plus the as-of month's
 * lines — both legs are entity-functional, so both must translate.
 */
test('bank balances translate every functional at the as-of spot', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const usSub = randomUUID()
    const usdBank = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${usdBank}, ${org.orgId}, '1010', 'USD Cash', 'asset_bank', ${usSub}, false, true)`)
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId},'USD','CAD','2026-07-15'::date,'spot',1.35,'manual')`)
      const calId = await db.execute(
        sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`,
      )
      const calRow = calId.rows[0]
      if (!calRow) throw new Error('scratch period has no fiscal calendar')
      const cal = String(calRow.fiscal_calendar_id)
      const june = randomUUID()
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${june}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${cal})`)
      // USD 100 posted in June (whole-month summary branch) + CAD 40 in July (as-of sliver branch).
      for (const [sub, acct, amt, cur, date, period] of [
        [usSub, usdBank, '100', 'USD', '2026-06-20', june],
        [org.subsidiaryId, org.accounts.bank, '40', 'CAD', '2026-07-14', org.periodId],
      ] as const) {
        const entryId = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${`BAL-${cur}`}, ${date}, ${period}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${acct}, ${sub}, ${amt}, ${cur}, ${amt}, 1),
                 (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${sub}, ${'-' + amt}, ${cur}, ${'-' + amt}, 1)`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      }
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const rows = await bankBalances('2026-07-15')
        const byName = new Map(rows.map((r) => [r.name, r.balance]))
        assert.equal(byName.get('USD Cash'), '135.0000')
        assert.equal(byName.get('Cash'), '40.0000')
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('bank balances fail closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const usSub = randomUUID()
    const usdBank = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${usdBank}, ${org.orgId}, '1010', 'USD Cash', 'asset_bank', ${usSub}, false, true)`)
      const entryId = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${usSub}, 'BAL-USD', '2026-07-14', ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${usdBank}, ${usSub}, '100', 'USD', '100', 1),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${usSub}, '-100', 'USD', '-100', 1)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(bankBalances('2026-07-15'), /no spot rate for USD/)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
