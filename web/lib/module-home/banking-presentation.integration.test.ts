import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { bankingHome, bankingReconCount } = await import('./banking.ts')
const { registerQueryObserver } = await import('@openbooks/engine/src/platform/query-observer.ts')

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
      [org.subsidiaryId, org.accounts.bank, '0.02', 'CAD'],
      [usSub, usdBank, '90071992547409.93', 'USD'],
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
        assert.equal(byName.get('USD Cash'), '121597189939003.4055')
        assert.equal(byName.get('Cash'), '0.0200')
        assert.equal(home.totalCash, '121597189939003.4255')
        const last = home.trend[home.trend.length - 1]!
        assert.equal(last.balance, '121597189939003.4255')
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * A multi-functional account rides one roster row per currency leg, but
 * each unmatched statement line contributes once to the tile. Reading this
 * queue must not require journal balances or exchange-rate coverage.
 */
test('reconciliation count dedupes a multi-functional account', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  try {
    await withBypass(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
      // Legs in two functionals on the SAME account → two roster rows.
      const legs = [
        [org.subsidiaryId, '100.00', 'CAD'],
        [usSub, '50.00', 'USD'],
      ] as const
      for (const [sub, amt, cur] of legs) {
        const entryId = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${`BANK-${cur}`}, ${D}, ${org.periodId}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${sub}, ${amt}, ${cur}, ${amt}, 1),
                 (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${sub}, ${'-' + amt}, ${cur}, ${'-' + amt}, 1)`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      }
      // Three unmatched lines and one matched line on that one account.
      const stmtId = randomUUID()
      await db.execute(sql`insert into bank_statements (id, org_id, account_id, source, statement_date, raw_file_ref)
        values (${stmtId}, ${org.orgId}, ${org.accounts.bank}, 'manual', ${D}::date, 'audit-log:test#evidence=legacy-source-unavailable')`)
      for (let i = 1; i <= 4; i++) {
        await db.execute(sql`insert into bank_statement_lines (id, org_id, statement_id, account_id, line_number, posted_on, amount, currency, match_status)
          values (${randomUUID()}, ${org.orgId}, ${stmtId}, ${org.accounts.bank}, ${i}, ${D}::date, '10.00', 'CAD', ${i === 4 ? 'matched' : 'unmatched'})`)
      }
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const home = await bankingHome(org.orgId)
        assert.equal(home.accounts.filter((a) => a.id === org.accounts.bank).length, 1)
        assert.equal(home.unmatchedLines, 3)
        assert.equal(await bankingReconCount(org.orgId), 3)
        assert.equal(await bankingReconCount(org.orgId), home.unmatchedLines)
        const journalBefore = (await db.execute(sql`select * from journal_lines where org_id=${org.orgId} order by id`)).rows
        await db.execute(sql`delete from fx_rates where org_id=${org.orgId}`)
        const statements: string[] = []
        const stopObserving = registerQueryObserver((statement) => statements.push(statement))
        try {
          assert.equal(await bankingReconCount(org.orgId), 3,
            'unmatched lines must remain readable without FX coverage')
        } finally {
          stopObserving()
        }
        assert.equal(statements.filter((statement) => /from bank_statement_lines/i.test(statement)).length, 1)
        assert.ok(!statements.some((statement) => /journal_lines|journal_entries|reconciliations|accounting_books|fx_rates/i.test(statement)),
          'a count-only tile must not read monetary balances or reconciliation history')
        assert.equal(await bankingReconCount(org.orgId, [usSub]), 3, 'shared accounts remain visible within a nonempty entity view')
        assert.equal(await bankingReconCount(org.orgId, []), 0, 'an empty entity view must not expose shared-account activity')
        const ownedBank = randomUUID(), ownedStatement = randomUUID()
        await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,is_active,is_summary,reconcilable)
          values(${ownedBank},${org.orgId},'1011','Operations Cash','asset_bank',${org.subsidiaryId},true,false,true)`)
        await db.execute(sql`insert into bank_statements(id,org_id,account_id,source,statement_date,raw_file_ref)
          values(${ownedStatement},${org.orgId},${ownedBank},'manual',${D}::date,'audit-log:test#evidence=legacy-source-unavailable')`)
        await db.execute(sql`insert into bank_statement_lines(id,org_id,statement_id,account_id,line_number,posted_on,amount,currency)
          values(${randomUUID()},${org.orgId},${ownedStatement},${ownedBank},1,${D}::date,'10.00','CAD')`)
        assert.equal(await bankingReconCount(org.orgId), 4)
        assert.equal(await bankingReconCount(org.orgId, [org.subsidiaryId]), 4)
        assert.equal(await bankingReconCount(org.orgId, [usSub]), 3, 'a hidden owned account contributes no statement lines')
        await db.execute(sql`update accounts set is_active=false where org_id=${org.orgId} and id=${ownedBank}`)
        assert.equal(await bankingReconCount(org.orgId, [org.subsidiaryId]), 3)
        assert.equal(await bankingReconCount(randomUUID()), 0, 'another organization cannot expose this account')
        await db.execute(sql`update accounts set is_active=false where org_id=${org.orgId} and id=${org.accounts.bank}`)
        assert.equal(await bankingReconCount(org.orgId), 0, 'inactive accounts stay outside roster membership')
        assert.deepEqual((await db.execute(sql`select * from journal_lines where org_id=${org.orgId} order by id`)).rows, journalBefore)
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
