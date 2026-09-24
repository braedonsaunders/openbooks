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
const { customersHome } = await import('./customers.ts')

const D = '2026-07-14'

/**
 * Receipt tiles convert every transaction amount at its posting FX rate
 * inside SQL decimal before aggregating: a USD 100 receipt posted to a CAD
 * subsidiary at 1.35 collects as 135 CAD — never as a raw 100 mixed with
 * unlike currencies.
 */
test('customer receipt totals convert each receipt at its posting rate', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    await withBypass(async () => {
      // Journal amounts are functional (txn × rate); the receipt tile under
      // test reads only the documents rows, but posting integrity demands
      // consistent legs.
      for (const [num, currency, fx, functional] of [
        ['RCPT-CAD', 'CAD', '1', '100'],
        ['RCPT-USD', 'USD', '1.35', '135'],
      ] as const) {
        const docId = randomUUID()
        const entryId = randomUUID()
        await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id,
            document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total)
          values (${docId}, ${org.orgId}, 'customer_payment', ${num}, ${org.customerId},
            ${org.subsidiaryId}, ${D}, ${D}, ${currency}, ${fx}, 'draft', 100, 0, 100)`)
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number,
            posting_date, period_id, status, origin, source_document_id)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${D},
            ${org.periodId}, 'draft', 'manual', ${docId})`)
        await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id,
            subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
          values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank},
            ${org.subsidiaryId}, ${org.customerId}, false, ${functional}, ${currency}, '100', ${fx}),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ar},
            ${org.subsidiaryId}, ${org.customerId}, false, ${'-' + functional}, ${currency}, '-100', ${fx})`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
        await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId},
          posting_period_id=${org.periodId} where id=${docId}`)
      }
    })
    await pinClock('2026-07-15', async () => {
      await withOrgContext(org.orgId, async () => {
        const home = await customersHome(org.orgId)
        assert.equal(home.badges.collected7d, 235, 'CAD 100 plus USD 100 at the 1.35 posting rate')
        assert.equal(
          home.trend.find((w) => w.collected > 0)?.collected,
          235,
          'the weekly trend converts before bucketing too',
        )
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
