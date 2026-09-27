import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { expensesDashboard } = await import('./expenses-dashboard.ts')

test('expense categories exclude secondary-book journal amounts', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const book = randomUUID()
    const document = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${book}, ${org.orgId}, 'ALT', 'Alternate', false, true, true)`)
      await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
        values (${document}, ${org.orgId}, 'expense_report', 'posted', 'EXP-BOOK', ${org.customerId}, ${org.subsidiaryId}, '2026-07-14', '2026-07-14', 'CAD', '1', '100', '0', '100')`)
      for (const [bookId, amount, tag] of [[org.bookId, '100', 'PRIMARY'], [book, '900', 'ALTERNATE']] as const) {
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
          values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`${tag}-${entry}`}, '2026-07-14', ${org.periodId}, 'posted', 'manual', ${document})`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
      }
    })
    await withSimClock('2026-07-15', async () => {
      const dashboard = await expensesDashboard(org.orgId, null)
      const category = dashboard.categories.find((row) => row.categoryId === org.accounts.cogs)
      assert.equal(category?.currentAmount, '100.0000')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
