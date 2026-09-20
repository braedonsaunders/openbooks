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
const { purchasingHome } = await import('./purchasing.ts')

const D = '2026-07-14'

async function seedTwoCurrencyPayables() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const usVend = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${usVend}, ${org.orgId}, 'vendor', 'US Vendor', true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // Posted bills (GL legs + document first leg) in both functionals.
    const bills = [
      ['BILL-CAD', org.subsidiaryId, org.vendorId, 'CAD', '100', '1'],
      ['BILL-USD', usSub, usVend, 'USD', '100', '1'],
    ] as const
    for (const [num, sub, party, cur, total, fx] of bills) {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', ${num}, ${party}, ${sub}, ${D}, ${D}, ${cur}, ${fx}, 'draft', ${total}, 0, ${total}, ${total})`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${sub}, ${party}, true, ${'-' + total}, ${cur}, ${'-' + total}, ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${sub}, ${party}, false, ${total}, ${cur}, ${total}, ${fx})`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    }
    // Posted payments (document reads for the 7-day badge) in both currencies,
    // each with a balanced posted entry like the landed currency test.
    for (const [num, sub, cur, fx] of [['PAY-CAD', org.subsidiaryId, 'CAD', '1'], ['PAY-USD', usSub, 'USD', '1']] as const) {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total)
        values (${docId}, ${org.orgId}, 'vendor_payment', ${num}, ${org.vendorId}, ${sub}, ${D}, ${D}, ${cur}, ${fx}, 'draft', 100, 0, 100)`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${sub}, ${org.vendorId}, false, '100', ${cur}, '100', ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${sub}, ${org.vendorId}, false, '-100', ${cur}, '-100', ${fx})`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    }
  })
  return { org, usVend }
}

/**
 * The purchasing cockpit states payables in the org's presentation currency.
 * Posted documents translate txn→functional at their maintained rate; the
 * cockpit still needs the second leg, functional→presentation — a USD bill
 * in a USD subsidiary is 135 CAD of spend and payables, not 100.
 */
test('purchasing cockpit translates every payable functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, usVend } = await seedTwoCurrencyPayables()
  try {
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const home = await purchasingHome(org.orgId)
        assert.equal(home.apOutstanding, 235)
        assert.equal(home.spend30d, 235)
        assert.equal(home.badges.paid7dValue, 235)
        assert.equal(home.trend.find((w) => w.spend > 0)?.spend, 235)
        const usRow = home.topExposure.find((r) => r.partyId === usVend)!
        assert.equal(usRow.billedOpen, 135)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('purchasing cockpit fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedTwoCurrencyPayables()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(purchasingHome(org.orgId), /no spot rate for USD/)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
