import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { businessToday } = await import('@openbooks/engine/src/platform/business-date.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { accountingHome } = await import('./accounting.ts')

/**
 * Accounting cockpit book scope: the posted tile counts entries in every
 * book, so a secondary book's postings inflate the primary ledger's hygiene
 * counts. Like the banking cockpit, the posted tile reads the primary
 * posting book. The draft tile instead ties to the /journal list: manual
 * drafts are documents (not entries yet, with no book), so it counts draft
 * journal documents.
 */
test('accounting journal tiles read the primary book only', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Ledger clerk', 'admin'))
  try {
    const today = await withBypass(() => businessToday(scratch.orgId))
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7))
    const monthStart = today.slice(0, 8) + '01'
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    const secondary = randomUUID()
    const periodId = randomUUID()
    await withBypass(async () => {
      const calendar = (
        await db.execute<{ id: string }>(sql`
          select fiscal_calendar_id as id from accounting_periods where id = ${scratch.periodId}
        `)
      ).rows[0]!.id
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${periodId}, ${scratch.orgId}, ${year}, ${month}, ${today.slice(0, 7)}, ${monthStart}, ${monthEnd}, false, ${calendar})
      `)
      await db.execute(sql`
        insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${secondary}, ${scratch.orgId}, 'TAX', 'Tax', false, true, true)
      `)
      // Manual drafts are documents (F-t06-014): seed two, one per book label —
      // documents carry no book, so both count, exactly like the /journal
      // draft list.
      let n = 0
      for (let i = 0; i < 2; i++) {
        n += 1
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, document_date, status, subsidiary_id, currency, total, created_by, updated_by)
          values
            (${randomUUID()}, ${scratch.orgId}, 'journal',
             ${`ACCT-DRAFT-${n}`}, ${today}, 'draft', ${scratch.subsidiaryId}, 'CAD', '0.0000', ${actorId}, ${actorId})
        `)
      }
      for (const [bookId, status, label] of [
        [scratch.bookId, 'posted', 'primary-posted'],
        [secondary, 'posted', 'secondary-posted'],
      ] as const) {
        n += 1
        const entryId = randomUUID()
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values
            (${entryId}, ${scratch.orgId}, ${bookId}, ${scratch.subsidiaryId},
             ${`ACCT-BOOK-${n}`}, ${today}, ${periodId},
             ${`Ledger book scope ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
        `)
        if (status === 'posted') {
          await db.execute(sql`
            insert into journal_lines
              (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
            values
              (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId},
               '10.0000', 'CAD', '10.0000', 1, ${`Ledger book scope ${label}`}),
              (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.adjustment}, ${scratch.subsidiaryId},
               '-10.0000', 'CAD', '-10.0000', 1, ${`Ledger book scope ${label}`})
          `)
          await db.execute(sql`
            update journal_entries set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
             where id = ${entryId} and org_id = ${scratch.orgId}
          `)
        }
      }
    })

    const home = await withBypass(() => accountingHome(scratch.orgId, null))
    assert.equal(home.draftJournals, 2, 'draft tile counts draft journal documents like the /journal list')
    assert.equal(home.postedJournals7d, 1, 'posted tile excludes the secondary-book posting')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
