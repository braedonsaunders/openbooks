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
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { openItems } = await import('./open-items.ts')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

// F-t03-010: a vendor bill listed TWICE in the payment-history dialog under
// the same record id with different dates, inflating the dialog total past
// the dashboard. The data is a textbook append-only correction —
// original entry reversed, reversal entry, correction re-post — and the
// duplicate was in the drill's query (it joined reversed entries without the
// document's current posting projection). The shared reader projects through
// posted_entry_id, so the corrected bill reads exactly once.
async function seedEntry(
  org: ScratchOrg,
  documentId: string,
  input: {
    number: string
    status: 'posted' | 'reversed'
    postingDate: string
    dueDate: string | null
    openItem: boolean
  },
): Promise<string> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      ${input.postingDate}, ${org.periodId}, 'draft', 'manual', ${documentId}
    )
  `)
  // Lines land while the entry is still a draft: lines of a reversed entry
  // are immutable, mirroring the kernel's append-only correction path.
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate, due_date
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
       ${org.vendorId}, ${input.openItem}, '-4237.50', 'CAD', '-4237.50', '1', ${input.dueDate}),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
       ${org.vendorId}, false, '4237.50', 'CAD', '4237.50', '1', ${input.dueDate})
  `)
  await db.execute(sql`update journal_entries set status = ${input.status} where id = ${entryId}`)
  return entryId
}

test('a corrected bill reads once through the current posting projection', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const documentId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents(
          id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
          posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance
        ) values (
          ${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-76913', ${org.vendorId},
          ${org.subsidiaryId}, '2026-08-18', '2026-08-18', 'CAD',
          '1', 'draft', '4237.50', 0, '4237.50', '4237.50'
        )
      `)
      // Original posting, later reversed — still carries its open-item flag,
      // exactly like the mirrored record.
      await seedEntry(org, documentId, { number: '76913', status: 'reversed', postingDate: '2026-08-18', dueDate: '2026-08-18', openItem: true })
      // Reversal entry carries no open payable leg.
      await seedEntry(org, documentId, { number: '76913-SOURCE-REV', status: 'posted', postingDate: '2026-08-18', dueDate: null, openItem: false })
      // Correction re-post with its own due date.
      const correctionId = await seedEntry(org, documentId, { number: '76913-SOURCE-CORR', status: 'posted', postingDate: '2026-08-18', dueDate: '2026-09-17', openItem: true })
      await db.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${correctionId}, posting_period_id = ${org.periodId}
         where id = ${documentId} and org_id = ${org.orgId}
      `)
    })

    await withOrgContext(org.orgId, async () => {
      const items = (await openItems(org.orgId, 'ap', '2026-09-17')).filter((item) => item.docId === documentId)
      assert.equal(items.length, 1, 'the corrected bill reads exactly once — the reversed original is not a second item')
      assert.equal(items[0]!.docNumber, 'BILL-76913')
      assert.equal(items[0]!.remaining, '4237.5000')
      assert.equal(items[0]!.dueDate?.toISOString().slice(0, 10), '2026-09-17', 'the surviving item carries the correction due date')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
