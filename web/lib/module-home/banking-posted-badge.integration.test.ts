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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { bankingHome } = await import('./banking.ts')

/**
 * F-t05-009: the banking work-queue badge reads "posted in the last 7 days"
 * but counted drafts. A scratch org with one draft + one posted deposit must
 * report txns7d = 1.
 */
test('banking txns7d counts only posted documents (F-t05-009)', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const today = await withBypass(() => businessToday(scratch.orgId))
    await withBypass(async () => {
      // Draft deposit: no journal entry, never posted.
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date, currency, status)
        values
          (${randomUUID()}, ${scratch.orgId}, 'deposit', 'DEP-DRAFT', ${scratch.subsidiaryId}, ${today}, 'CAD', 'draft')
      `)
      // Posted deposit: draft doc + draft entry, then both posted like the
      // purchasing presentation fixture does.
      const docId = randomUUID()
      const entryId = randomUUID()
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date, posting_date, currency, status, subtotal, tax_total, total)
        values
          (${docId}, ${scratch.orgId}, 'deposit', 'DEP-POSTED', ${scratch.subsidiaryId}, ${today}, ${today}, 'CAD', 'draft', 100, 0, 100)
      `)
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values
          (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'DEP-POSTED', ${today}, ${scratch.periodId}, 'draft', 'manual', ${docId})
      `)
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values
          (${randomUUID()}, ${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, '100.0000', 'CAD', '100.0000', 1),
          (${randomUUID()}, ${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.adjustment}, ${scratch.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', 1)
      `)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`)
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entryId}, posting_period_id=${scratch.periodId} where id=${docId}`)
    })
    const home = await withBypass(() => bankingHome(scratch.orgId))
    assert.equal(home.badges.txns7d, 1, 'draft deposit must not inflate the posted-7d badge')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
