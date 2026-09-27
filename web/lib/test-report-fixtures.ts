import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'

type ScratchOrg = import('@openbooks/engine/src/testing/fixtures.ts').ScratchOrg

export async function seedFeatureDisableBookScope(org: ScratchOrg) {
  const bookId = randomUUID()
  const subsidiaryId = randomUUID()
  const entryId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${bookId}, ${org.orgId}, 'ALT', 'Alternate', false, true, true)`)
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_elimination, is_active)
      values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA', false, true)`)
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,retainageReceivable}', ${JSON.stringify(org.accounts.revenue)}::jsonb, true)
      where id = ${org.orgId}`)
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${bookId}, ${subsidiaryId}, 'ALT-BOOK', ${org.date}, ${org.periodId}, 'draft', 'manual')`)
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.revenue}, ${subsidiaryId}, '100', 'CAD', '80', '1.25'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${subsidiaryId}, '-100', 'CAD', '-80', '1.25'),
             (${org.orgId}, ${entryId}, 3, ${org.accounts.revenue}, ${org.subsidiaryId}, '50', 'CAD', '40', '1.25'),
             (${org.orgId}, ${entryId}, 4, ${org.accounts.bank}, ${org.subsidiaryId}, '-50', 'CAD', '-40', '1.25')`)
    const posted = await db.execute(sql`update journal_entries set status = 'posted', posted_at = now()
      where id = ${entryId} and org_id = ${org.orgId} returning id`)
    if (posted.rows.length !== 1) throw new Error('the secondary-book feature fixture did not post')
  })
}

export async function seedExpensesDashboardBookScope(org: ScratchOrg) {
  const bookId = randomUUID()
  const documentId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${bookId}, ${org.orgId}, 'ALT', 'Alternate', false, true, true)`)
    await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, posting_period_id)
      values (${documentId}, ${org.orgId}, 'expense_report', 'draft', 'EXP-BOOK', ${org.customerId}, ${org.subsidiaryId}, '2026-07-14', '2026-07-14', 'CAD', '1', '100', '0', '100', ${org.periodId})`)
    let primaryEntryId = ''
    for (const [entryBookId, amount, tag] of [[org.bookId, '100', 'PRIMARY'], [bookId, '900', 'ALTERNATE']] as const) {
      const entryId = randomUUID()
      if (entryBookId === org.bookId) primaryEntryId = entryId
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${entryId}, ${org.orgId}, ${entryBookId}, ${org.subsidiaryId}, ${`${tag}-${entryId}`}, '2026-07-14', ${org.periodId}, 'draft', 'manual', ${documentId})`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
      const posted = await db.execute(sql`update journal_entries set status = 'posted', posted_at = now()
        where id = ${entryId} and org_id = ${org.orgId} returning id`)
      if (posted.rows.length !== 1) throw new Error('an expense book fixture entry did not post')
    }
    const postedDocument = await db.execute(sql`update documents set status = 'posted', posted_entry_id = ${primaryEntryId}
      where id = ${documentId} and org_id = ${org.orgId} returning id`)
    if (postedDocument.rows.length !== 1) throw new Error('the expense book fixture document did not post')
  })
}

export async function seedCustomerSecondaryBookReceivable(org: ScratchOrg, documentDate: string) {
  const bookId = randomUUID()
  const documentId = randomUUID()
  const entryId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${bookId}, ${org.orgId}, 'ALT', 'Alternate', false, true, true)`)
    await db.execute(sql`insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-ALT-BOOK', ${org.customerId}, ${org.subsidiaryId}, ${documentDate}, ${documentDate}, 'CAD', '1', 'draft', '9000', '0', '9000', '9000')`)
    await db.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
      values (${entryId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, 'INV-ALT-BOOK', ${documentDate}, ${org.periodId}, 'draft', 'manual', ${documentId})`)
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, true, '9000', 'CAD', '9000', '1'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${org.customerId}, false, '-9000', 'CAD', '-9000', '1')`)
    const posted = await db.execute(sql`update journal_entries set status='posted', posted_at=now()
      where id=${entryId} and org_id=${org.orgId} returning id`)
    if (posted.rows.length !== 1) throw new Error('the secondary-book receivable entry did not post')
    const postedDocument = await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${org.periodId}
      where id=${documentId} and org_id=${org.orgId} returning id`)
    if (postedDocument.rows.length !== 1) throw new Error('the secondary-book receivable document did not post')
  })
}
