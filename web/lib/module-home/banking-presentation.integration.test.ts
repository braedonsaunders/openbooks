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
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { bankingHome } = await import('./banking.ts')

const D = '2026-07-14'

async function seedTwoCurrencyCash() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const usdBank = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active, reconcilable, currency_restriction)
      values (${usdBank}, ${org.orgId}, '1010', 'USD Cash', 'asset_bank', ${usSub}, false, true, true, 'USD')`)
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    const legs = [
      [org.subsidiaryId, org.accounts.bank, '40', 'CAD'],
      [usSub, usdBank, '100', 'USD'],
    ] as const
    for (const [sub, acct, amt, cur] of legs) {
      const entryId = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${`BANK-${cur}`}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${acct}, ${sub}, ${amt}, ${cur}, ${amt}, 1),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${sub}, ${'-' + amt}, ${cur}, ${'-' + amt}, 1)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
    }
  })
  return org
}

/**
 * The banking cockpit states cash in the org's presentation currency: a USD
 * 100 account at a 1.35 spot is 135 CAD of cash, not 100 — in the roster,
 * the total, and the trend alike.
 */
test('banking cockpit translates every cash functional at the tile spot', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyCash()
  try {
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const home = await bankingHome(org.orgId)
        const byName = new Map(home.accounts.map((a) => [a.name, a.balance]))
        assert.equal(byName.get('USD Cash'), 135)
        assert.equal(byName.get('Cash'), 40)
        assert.equal(home.totalCash, 175)
        const last = home.trend[home.trend.length - 1]!
        assert.equal(last.balance, 175)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('banking cockpit fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyCash()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(bankingHome(org.orgId), /no spot rate for USD/)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
