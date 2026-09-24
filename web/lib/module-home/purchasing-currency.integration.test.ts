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
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock: pinClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { purchasingHome } = await import('./purchasing')

async function seedPostedDocument(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  input: { kind: 'vendor_bill' | 'vendor_payment'; number: string; date: string; currency: string; total: string; fxRate: string },
) {
  const documentId = randomUUID()
  const entryId = randomUUID()
  const controlLineId = randomUUID()
  const otherLineId = randomUUID()
  const functionalTotal = input.currency === 'USD' && input.fxRate === '1.35' ? '135' : input.total
  // Fixture writes run under the test bypass; the presentation read below
  // runs under withOrgContext, proving enforcement visibility.
  await withBypassContext(async () => {
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total
    ) values (
      ${documentId}, ${org.orgId}, ${input.kind}, ${input.number}, ${org.vendorId},
      ${org.subsidiaryId}, ${input.date}, ${input.date}, ${input.currency},
      ${input.fxRate}, 'draft', ${input.total}, 0, ${input.total}
    )
  `)
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      ${input.date}, ${org.periodId}, 'draft', 'manual', ${documentId}
    )
  `)
  const controlAmount = input.kind === 'vendor_bill' ? `-${functionalTotal}` : functionalTotal
  const otherAmount = input.kind === 'vendor_bill' ? functionalTotal : `-${functionalTotal}`
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${controlLineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
       ${org.vendorId}, true, ${controlAmount}, ${input.currency},
       ${input.kind === 'vendor_bill' ? `-${input.total}` : input.total}, ${input.fxRate}),
      (${otherLineId}, ${org.orgId}, ${entryId}, 2,
       ${input.kind === 'vendor_bill' ? org.accounts.cogs : org.accounts.bank}, ${org.subsidiaryId},
       ${org.vendorId}, false, ${otherAmount}, ${input.currency},
       ${input.kind === 'vendor_bill' ? input.total : `-${input.total}`}, ${input.fxRate})
  `)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
     where id = ${documentId} and org_id = ${org.orgId}
  `)
  })
}

test('purchasing scalar metrics convert transaction-currency documents before org formatting', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await pinClock('2026-07-15', async () => {
      await seedPostedDocument(org, {
        kind: 'vendor_bill', number: 'BILL-CAD', date: '2026-07-14', currency: 'CAD', total: '100', fxRate: '1',
      })
      await seedPostedDocument(org, {
        kind: 'vendor_bill', number: 'BILL-USD', date: '2026-07-14', currency: 'USD', total: '100', fxRate: '1.35',
      })
      await seedPostedDocument(org, {
        kind: 'vendor_payment', number: 'PAY-CAD', date: '2026-07-14', currency: 'CAD', total: '100', fxRate: '1',
      })
      await seedPostedDocument(org, {
        kind: 'vendor_payment', number: 'PAY-USD', date: '2026-07-14', currency: 'USD', total: '100', fxRate: '1.35',
      })

      await withOrgContext(org.orgId, async () => {
        const home = await purchasingHome(org.orgId)
        assert.equal(home.spend30d, 235, '30-day spend is shown in organization currency')
        assert.equal(home.badges.paid7dValue, 235, '7-day payments are shown in organization currency')
        assert.equal(home.trend.find((week) => week.spend > 0)?.spend, 235, 'trend spend is shown in organization currency')
      })
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
