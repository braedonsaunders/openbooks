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
const { vendorData } = await import('./vendor-data')

const D = '2026-07-14'
const P = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencySpend() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const usVend = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${usVend}, ${org.orgId}, 'vendor', 'US Vendor', ${usSub}, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual'),
             (${org.orgId},'USD','CAD','2025-07-14','spot',1.3,'manual')`)
    const calRow = await db.execute(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)
    const calRow0 = calRow.rows[0]
    if (!calRow0) throw new Error('scratch period has no fiscal calendar')
    const cal = String(calRow0.fiscal_calendar_id)
    const priorPeriod = randomUUID()
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${priorPeriod}, ${org.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31', false, ${cal})`)
    // Bills post expense legs with the vendor party: CAD 100 (Main, July),
    // USD 100 (US, July), USD 100 (US, prior July).
    const bills = [
      ['BILL-CAD', org.subsidiaryId, org.vendorId, 'CAD', '100', '1', D, org.periodId, null],
      ['BILL-USD', usSub, usVend, 'USD', '100', '1', D, org.periodId, '2026-07-10'],
      ['BILL-PRIOR', usSub, usVend, 'USD', '100', '1', '2025-07-15', priorPeriod, null],
    ] as const
    let usBillLine = ''
    for (const [num, sub, party, cur, total, fx, date, period, due] of bills) {
      const docId = randomUUID()
      const entryId = randomUUID()
      const lineId = randomUUID()
      if (num === 'BILL-USD') usBillLine = lineId
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', ${num}, ${party}, ${sub}, ${date}, ${date}, ${cur}, ${fx}, 'draft', ${total}, 0, ${total}, ${total})`)
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${date}, ${period}, 'draft', 'manual', ${docId})`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, due_date, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${lineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${sub}, ${party}, ${due}, true, ${'-' + total}, ${cur}, ${'-' + total}, ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${sub}, ${party}, ${due}, false, ${total}, ${cur}, ${total}, ${fx})`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${period} where id=${docId}`)
    }
    // Fully pay the USD bill late (due 07-10, paid 07-14): the late-spend leg
    // is USD-functional and must translate too.
    const payEntry = randomUUID()
    const payLine = randomUUID()
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${payEntry}, ${org.orgId}, ${org.bookId}, ${usSub}, 'PAY-USD', ${D}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
      values (${payLine}, ${org.orgId}, ${payEntry}, 1, ${org.accounts.ap}, ${usSub}, ${usVend}, true, '100', 'USD', '100', 1),
             (${randomUUID()}, ${org.orgId}, ${payEntry}, 2, ${org.accounts.bank}, ${usSub}, ${usVend}, false, '-100', 'USD', '-100', 1)`)
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${payEntry}`)
    await db.execute(sql`insert into applications (id, org_id, from_line_id, to_line_id, amount, source_amount,
      source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
      settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on, created_by)
      values (${randomUUID()}, ${org.orgId}, ${payLine}, ${usBillLine}, 100, 100, 100, 'USD', 100, 'USD',
        1, 'same_currency', 'same transaction currency', ${D}, ${org.orgId})`)
  })
  return { org, usVend }
}

/**
 * Vendor spend is stated in the org's presentation currency: a USD 100 bill
 * in a USD subsidiary is 135 CAD of spend (130 at its own prior-year rate),
 * and late-paid USD legs translate the same way — not 100 everywhere.
 */
test('vendor performance translates every spend functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, usVend } = await seedTwoCurrencySpend()
  try {
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const data = await vendorData(P, org.orgId, null)
        const usRow = data.rows.find((r) => r.id === usVend)!
        assert.equal(usRow.spend, 135)
        assert.equal(usRow.priorSpend, 130)
        assert.equal(usRow.lateSpend, 135)
        assert.equal(data.totals.spend, 235)
        assert.equal(data.totals.priorSpend, 130)
        assert.equal(data.totals.lateSpend, 135)
        assert.equal(data.monthly.find((m) => m.month === '2026-07')?.spend, 235)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('vendor performance fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedTwoCurrencySpend()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        await assert.rejects(vendorData(P, org.orgId, null), /no spot rate for USD/)
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
