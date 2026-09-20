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
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { spendVelocityData } = await import('./spend-velocity-data')
// The data layer pulls in web/lib/auth, whose request-org module registers
// its Next request-store RLS resolver at import time — after the runner's
// trusted test bypass. Outside a request that resolver denies everything,
// so scratch reads come back empty. Re-assert the bypass here, after every
// import, so this file sees its own fixtures.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()

const D = '2026-07-14'
const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencySpend() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  // A genuine COGS-typed account: the scratch fixture types every P&L
  // account 'expense', which would hide a COGS-vs-OpEx mix-up. F-t09-001.
  const cogsAccountId = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${cogsAccountId}, ${org.orgId}, '5001', 'True COGS', 'cogs', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // CAD bill posts to an expense account; USD bill posts to the COGS
    // account. Both belong to the spend-document universe (235 CAD total).
    const bills = [
      ['BILL-CAD', org.subsidiaryId, org.vendorId, 'CAD', '100', '1', org.accounts.freight],
      ['BILL-USD', usSub, org.vendorId, 'USD', '100', '1', cogsAccountId],
    ] as const
    for (const [num, sub, party, cur, total, fx, accountId] of bills) {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', ${num}, ${party}, ${sub}, ${D}, ${D}, ${cur}, ${fx}, 'draft', ${total}, 0, ${total}, ${total})`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${sub}, ${party}, true, ${'-' + total}, ${cur}, ${'-' + total}, ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${accountId}, ${sub}, ${party}, false, ${total}, ${cur}, ${total}, ${fx})`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    }
    // Genuine operating expense with NO spend document (e.g. depreciation):
    // a manual GL journal the spend-document universe never sees. F-t09-001.
    const opexEntry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${opexEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'OPEX-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${randomUUID()}, ${org.orgId}, ${opexEntry}, 1, ${org.accounts.freight}, ${org.subsidiaryId}, '50', 'CAD', '50', 1),
             (${randomUUID()}, ${org.orgId}, ${opexEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-50', 'CAD', '-50', 1)`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${opexEntry}`)
    // Commitments (document totals, no postings): CAD PO 100 + USD PO 100.
    for (const [num, sub, cur, total] of [['PO-CAD', org.subsidiaryId, 'CAD', '100'], ['PO-USD', usSub, 'USD', '100']] as const) {
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total)
        values (${randomUUID()}, ${org.orgId}, 'purchase_order', ${num}, ${org.vendorId}, ${sub}, ${D}, ${D}, ${cur}, 1, 'approved', ${total}, 0, ${total})`)
    }
    // Income lines (GL only) funding the OpEx ratio: CAD 470.
    const revEntry = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${revEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'REV-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${randomUUID()}, ${org.orgId}, ${revEntry}, 1, ${org.accounts.revenue}, ${org.subsidiaryId}, '-470', 'CAD', '-470', 1),
             (${randomUUID()}, ${org.orgId}, ${revEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '470', 'CAD', '470', 1)`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${revEntry}`)
  })
  return org
}

/**
 * Spend velocity compares monthly series across accounts, vendors, and
 * commitment kinds: every leg must sit in the presentation currency or the
 * velocity math, detectors, and YoY trends compare unlike currencies. A USD
 * 100 bill in a USD subsidiary is 135 CAD of spend — in totals, series,
 * commitments, and prior windows alike.
 */
test('spend velocity translates every spend functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencySpend()
  try {
    await pinClock('2026-07-15', async () => {
      const data = await spendVelocityData(org.orgId, P, null)
      assert.equal(data.summary.totalSpend, 235)
      assert.equal(data.summary.billsTotal, 235)
      assert.equal(data.monthlyTrends.find((m) => m.month === '2026-07')?.totalAmount, 235)
      assert.equal(data.commitmentCliff.summary.totalPO, 235)
      assert.equal(data.revenue.totalRevenue, 470)
      // P&L operating expenses are the 100 CAD bill plus the 50 CAD manual
      // journal; the 135 CAD of COGS spend must not feed the "Operating
      // expenses … of revenue" ratio (F-t09-001).
      assert.equal(data.revenue.opexRatio, 32)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * Mid-year go-live: the first spend posts inside the current window while the
 * prior window predates cutover. Change-vs-prior is UNKNOWN (null) there —
 * a first period of spend must never read as +100% growth against no data.
 */
test('period comparison reports unknown change when the prior window has no history', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', 'BILL-FIRST', ${org.vendorId}, ${org.subsidiaryId}, ${D}, ${D}, 'CAD', 1, 'draft', 100, 0, 100, 100)`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-FIRST', ${D}, ${org.periodId}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, true, '-100', 'CAD', '-100', 1),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, ${org.vendorId}, false, '100', 'CAD', '100', 1)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId} where id=${docId}`)
    })
    await pinClock('2026-07-15', async () => {
      const data = await spendVelocityData(org.orgId, P, null)
      const row = data.periodComparison.accounts.find((a) => a.currentAmount > 0)
      assert.ok(row, 'expected one spend row in the current window')
      assert.equal(row.priorAmount, 0)
      assert.equal(row.isNew, true)
      assert.equal(row.changePct, null)
      assert.equal(data.periodComparison.summary.priorTotal, 0)
      assert.equal(data.periodComparison.summary.changePct, null)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('spend velocity fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencySpend()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await assert.rejects(spendVelocityData(org.orgId, P, null), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
