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
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { purchasingHome } = await import('./purchasing')
const { openItems, summariseSide, buildWeekGrid } = await import('../cash/core.ts')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

// F-t04-012: the purchasing Payment pulse "open" did not tie to AP open
// payables ($229K vs $265K, drifting between sessions). The pulse aggregate
// nets applications LIVE and has no posting-date cutoff, while the /ap house
// engine nets applications AS OF the forecast date and only counts entries
// posted on/before it. A bill posted in the future must not count yet; a
// bill covered only by a future-dated application still counts today.
async function seedBill(
  org: ScratchOrg,
  input: { number: string; posted: string; due: string; total: string },
): Promise<{ documentId: string; controlLineId: string }> {
  const documentId = randomUUID()
  const entryId = randomUUID()
  const controlLineId = randomUUID()
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance
    ) values (
      ${documentId}, ${org.orgId}, 'vendor_bill', ${input.number}, ${org.vendorId},
      ${org.subsidiaryId}, ${input.posted}, ${input.posted}, 'CAD',
      '1', 'draft', ${input.total}, 0, ${input.total}, ${input.total}
    )
  `)
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      ${input.posted}, ${org.periodId}, 'draft', 'manual', ${documentId}
    )
  `)
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate, due_date
    ) values
      (${controlLineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
       ${org.vendorId}, true, ${'-' + input.total}, 'CAD',
       ${'-' + input.total}, '1', ${input.due}),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
       ${org.vendorId}, false, ${input.total}, 'CAD',
       ${input.total}, '1', ${input.due})
  `)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${documentId} and org_id = ${org.orgId}
  `)
  return { documentId, controlLineId }
}

test('payment pulse open ties to AP open payables across time boundaries', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await pinClock('2026-09-17', async () => {
      // Open and overdue as of the clock.
      await withBypass(async () => {
      await seedBill(org, { number: 'BILL-OPEN', posted: '2026-09-01', due: '2026-09-01', total: '1000' })
      // Posted in the future: not open yet.
      await seedBill(org, { number: 'BILL-FUTURE', posted: '2026-12-10', due: '2027-01-09', total: '2000' })
      // Covered only by a future-dated application: still open today.
      const futurePaid = await seedBill(org, { number: 'BILL-FUTURE-PAID', posted: '2026-09-01', due: '2026-10-01', total: '3000' })
      const paymentId = randomUUID()
      const paymentEntryId = randomUUID()
      const paymentLineId = randomUUID()
      await db.execute(sql`
        insert into documents(
          id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
          posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance
        ) values (
          ${paymentId}, ${org.orgId}, 'vendor_payment', 'PAY-FUTURE', ${org.vendorId},
          ${org.subsidiaryId}, '2026-09-01', '2026-09-01', 'CAD',
          '1', 'draft', 3000, 0, 3000, 0
        )
      `)
      await db.execute(sql`
        insert into journal_entries(
          id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
          status, origin, source_document_id
        ) values (
          ${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PAY-FUTURE',
          '2026-09-01', ${org.periodId}, 'draft', 'manual', ${paymentId}
        )
      `)
      await db.execute(sql`
        insert into journal_lines(
          id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
          is_open_item, amount, currency, txn_amount, fx_rate
        ) values
          (${paymentLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
           ${org.vendorId}, true, 3000, 'CAD', 3000, '1'),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
           ${org.vendorId}, false, -3000, 'CAD', -3000, '1')
      `)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${paymentEntryId}`)
      await db.execute(sql`
        update documents set status = 'posted', posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}
         where id = ${paymentId} and org_id = ${org.orgId}
      `)
      await db.execute(sql`
        insert into applications(
          id, org_id, from_line_id, to_line_id, amount, applied_on,
          source_amount, source_transaction_amount, source_transaction_currency,
          target_transaction_amount, target_transaction_currency,
          settlement_rate, settlement_rate_source, settlement_rate_reference
        ) values (
          ${randomUUID()}, ${org.orgId}, ${paymentLineId}, ${futurePaid.controlLineId}, 3000, '2026-10-01',
          3000, 3000, 'CAD', 3000, 'CAD', 1, 'same_currency', 'test'
        )
      `)

      })

      await withOrgContext(org.orgId, async () => {
        const home = await purchasingHome(org.orgId)
        const grid = buildWeekGrid('2026-09-17', 4)
        const items = await openItems(org.orgId, 'ap', '2026-09-17')
        const house = summariseSide(items, grid.asOf, '0', 0)
        assert.equal(
          home.apOutstanding,
          Number(house.outstanding),
          `pulse open (${home.apOutstanding}) must tie to AP outstanding (${house.outstanding})`,
        )
        assert.equal(home.apOutstanding, 4000, 'open = overdue bill + future-paid bill; future-posted excluded')
        assert.equal(home.apOverdue, 1000, 'only the past-due bill is overdue')
        // F-t03-009: the hero roster groups the SAME as-of item set as the
        // pulse — one page, one Talent figure. The old live aggregate gated
        // on the cached open_balance (which the seed never decrements), so
        // it showed the future-posted bill and dropped the future-paid one.
        assert.equal(home.topExposure.length, 1, 'single vendor row for the single seeded vendor')
        const hero = home.topExposure[0]!
        assert.equal(hero.billedOpen, 4000, 'hero billed-open ties the pulse open')
        assert.equal(hero.overdue, 1000, 'hero overdue ties the pulse overdue')
        assert.equal(hero.openBills, 2, 'hero counts the two as-of-open bills, not the future-posted one')
        assert.equal(hero.oldestDue, '2026-09-01', 'hero oldest-due is the overdue bill')
        assert.equal(
          home.topExposure.reduce((sum, row) => sum + row.billedOpen, 0),
          home.apOutstanding,
          'hero billed-open foots to the pulse outstanding',
        )
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
