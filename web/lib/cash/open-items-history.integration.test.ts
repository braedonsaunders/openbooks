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
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { openItems } = await import('./open-items.ts')

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>

// F-m14: the reader joined the document's LIVE posted_entry_id with the live
// status, so later history rewrote earlier forecasts — a bill corrected in
// August read zero open at a July as-of, and a voided bill vanished from
// every earlier date. Seeds below mirror the kernel's append-only end state
// (original entry reversed, reversal entry linked, correction re-posted with
// the pointer moved; void stamping voided_at), and the reader must
// reconstruct each date from that history.

// Mirrors the kernel's entry shape: lines land while the entry is a draft,
// reversal entries carry the link and no open-item legs.
async function seedEntry(
  org: ScratchOrg,
  documentId: string,
  input: {
    number: string
    status: 'posted' | 'reversed'
    postingDate: string
    dueDate: string | null
    openItem: boolean
    amount: string
    reversesEntryId?: string
  },
): Promise<string> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, source_document_id, reverses_entry_id
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${input.number},
      ${input.postingDate}, ${org.periodId}, 'draft', 'manual', ${documentId}, ${input.reversesEntryId ?? null}
    )
  `)
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id,
      is_open_item, amount, currency, txn_amount, fx_rate, due_date
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId},
       ${org.vendorId}, ${input.openItem}, ${`-${input.amount}`}, 'CAD', ${`-${input.amount}`}, '1', ${input.dueDate}),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
       ${org.vendorId}, false, ${input.amount}, 'CAD', ${input.amount}, '1', ${input.dueDate})
  `)
  await db.execute(sql`update journal_entries set status = ${input.status} where id = ${entryId}`)
  return entryId
}

async function seedDocument(
  org: ScratchOrg,
  documentId: string,
  input: { number: string; total: string },
): Promise<void> {
  await db.execute(sql`
    insert into documents(
      id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
      posting_date, currency, fx_rate, status, subtotal, tax_total, total
    ) values (
      ${documentId}, ${org.orgId}, 'vendor_bill', ${input.number}, ${org.vendorId},
      ${org.subsidiaryId}, '2026-08-01', '2026-08-01', 'CAD',
      '1', 'draft', ${input.total}, 0, ${input.total}
    )
  `)
}

test('a corrected bill stays open at dates before its correction', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const documentId = randomUUID()
    await withBypass(async () => {
      await seedDocument(org, documentId, { number: 'BILL-CORR-1', total: '1000.00' })
      const original = await seedEntry(org, documentId, {
        number: 'CORR-1', status: 'reversed', postingDate: '2026-08-01',
        dueDate: '2026-08-01', openItem: true, amount: '1000.00',
      })
      const reversal = await seedEntry(org, documentId, {
        number: 'CORR-1-REV', status: 'posted', postingDate: '2026-08-15',
        dueDate: null, openItem: false, amount: '1000.00', reversesEntryId: original,
      })
      assert.ok(reversal)
      const correction = await seedEntry(org, documentId, {
        number: 'CORR-1-CORR', status: 'posted', postingDate: '2026-08-15',
        dueDate: '2026-09-01', openItem: true, amount: '1000.00',
      })
      await db.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${correction}, posting_period_id = ${org.periodId}
         where id = ${documentId} and org_id = ${org.orgId}
      `)
    })

    await withOrgContext(org.orgId, async () => {
      // Before the correction only the original projection existed.
      const before = (await openItems(org.orgId, 'ap', '2026-08-10')).filter((item) => item.docId === documentId)
      assert.equal(before.length, 1, 'the bill was open before its correction moved the pointer')
      assert.equal(before[0]!.remaining, '1000.0000')
      assert.equal(before[0]!.dueDate?.toISOString().slice(0, 10), '2026-08-01')
      // After it, exactly the correction projection reads — once.
      const after = (await openItems(org.orgId, 'ap', '2026-09-20')).filter((item) => item.docId === documentId)
      assert.equal(after.length, 1, 'the corrected bill reads exactly once')
      assert.equal(after[0]!.remaining, '1000.0000')
      assert.equal(after[0]!.dueDate?.toISOString().slice(0, 10), '2026-09-01')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('a voided bill stays open at dates before its void, hidden after', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const documentId = randomUUID()
    await withBypass(async () => {
      await seedDocument(org, documentId, { number: 'BILL-VOID-1', total: '500.00' })
      const original = await seedEntry(org, documentId, {
        number: 'VOID-1', status: 'reversed', postingDate: '2026-08-01',
        dueDate: '2026-08-01', openItem: true, amount: '500.00',
      })
      const reversal = await seedEntry(org, documentId, {
        number: 'VOID-1-REV', status: 'posted', postingDate: '2026-08-20',
        dueDate: null, openItem: false, amount: '500.00', reversesEntryId: original,
      })
      const voider = await createScratchUser(org.orgId, 'Void Clerk', 'admin')
      await db.execute(sql`
        update documents
           set status = 'voided', posted_entry_id = ${original}, posting_period_id = ${org.periodId},
               voided_at = '2026-08-20 10:00:00+00', voided_by = ${voider},
               void_reason = 'history test void', reversal_entry_id = ${reversal}
         where id = ${documentId} and org_id = ${org.orgId}
      `)
    })

    await withOrgContext(org.orgId, async () => {
      const before = (await openItems(org.orgId, 'ap', '2026-08-10')).filter((item) => item.docId === documentId)
      assert.equal(before.length, 1, 'the bill was open before its void')
      assert.equal(before[0]!.remaining, '500.0000')
      const after = (await openItems(org.orgId, 'ap', '2026-08-25')).filter((item) => item.docId === documentId)
      assert.equal(after.length, 0, 'the void hides the bill from its date forward')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
