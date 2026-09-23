import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// A parallel accounting book's mirror entries must not fuse into AR/AP
// aging: a primary $500 invoice plus a secondary-book $500 mirror used to
// age as $1,000, because the control residual summed journal lines across
// every book while the document side rebuilt only each posted entry.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { agingByParty, agingDetail } = await import('./aging.ts')
const { partnerStatement } = await import('./registers.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

test(
  'aging stays primary-scoped with a parallel book present',
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const taxBookId = randomUUID()
    const docId = randomUUID()
    const primaryEntryId = randomUUID()
    const taxEntryId = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
          values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax book', false, true, true)
        `),
      )
      const postMirror = (entryId: string, bookId: string, tag: string) =>
        withBypass(async () => {
          await db.execute(sql`
            insert into journal_entries
              (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
               period_id, memo, status, origin)
            values
              (${entryId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId},
               ${`AGEBOOK-${tag}`}, ${org.date}, ${org.periodId},
               ${tag}, 'draft', 'manual')`)
          await db.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id,
               party_id, amount, currency, txn_amount, fx_rate, is_open_item)
            values
              (${org.orgId}, ${entryId}, 1, ${org.accounts.ar},
               ${org.subsidiaryId}, ${org.customerId}, '500.0000', 'CAD', '500.0000', '1', true),
              (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue},
               ${org.subsidiaryId}, ${org.customerId}, '-500.0000', 'CAD', '-500.0000', '1', false)`)
          await db.execute(sql`
            update journal_entries set status = 'posted', posted_at = now()
             where id = ${entryId}`)
        })
      await postMirror(primaryEntryId, org.bookId, 'PRI')
      await postMirror(taxEntryId, taxBookId, 'TAX')
      await withBypass(() =>
        db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, document_date, posting_date, due_date,
             currency, fx_rate, subtotal, tax_total, total, status, posted_entry_id,
             posting_period_id, open_balance, subsidiary_id)
          values
            (${docId}, ${org.orgId}, 'customer_invoice', 'INV-AGE-1', ${org.customerId},
             ${org.date}, ${org.date}, ${org.date}, 'CAD', '1', '500.0000', '0.0000', '500.0000',
             'posted', ${primaryEntryId}, ${org.periodId}, '500.0000', ${org.subsidiaryId})
        `),
      )

      await withOrgContext(org.orgId, async () => {
        // Default scope is the primary book only — never the merged pair.
        const summary = await agingByParty('ar', org.date, undefined, org.orgId)
        assert.equal(String(summary.totals.total), '500.0000')

        const detail = await agingDetail('ar', org.date, undefined, org.orgId)
        assert.equal(detail.rows.length, 1)
        assert.equal(String(detail.rows[0]!.open), '500.0000')
        assert.equal(String(detail.totals.total), '500.0000')

        // An explicit book reads that book — the tax mirror is intact.
        const taxSummary = await agingByParty('ar', org.date, undefined, org.orgId, { bookId: taxBookId })
        assert.equal(String(taxSummary.totals.total), '500.0000')

        // The partner statement ties: register and aged footer agree.
        const stmt = await partnerStatement(org.customerId, org.orgId, {
          from: org.date,
          to: org.date,
          side: 'ar',
        })
        assert.equal(String(stmt.closing), '500.0000')
        assert.equal(String(stmt.aging.total), '500.0000')
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
