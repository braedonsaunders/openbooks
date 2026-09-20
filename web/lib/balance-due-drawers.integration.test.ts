import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { loadDocument } = await import('./documents')
const { loadPdfRecordValues } = await import('./pdf-templates/values')

/**
 * Drawer, customer PDF, and dunning share one balance-due reader
 * (engine/src/records/balance-due.ts). This test pins the two web surfaces to the
 * hand-computed figures: a partially paid invoice AND a partially consumed
 * credit memo. The credit is the leg trap — it is consumed through the
 * from-leg, so a to-leg-only reader reports the full 60 as still due on the
 * drawer and on the customer's PDF while the aging shows 35.
 */
test('drawer and PDF agree on invoice and credit balances due', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Balance Drawer', 'admin'))
    const ids = await withBypass(async () => {
      async function postDoc(kind: string, total: string): Promise<{ id: string; line: string }> {
        const id = randomUUID()
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date,
           currency, fx_rate, subtotal, tax_total, total, created_by)
          values (${id}, ${scratch.orgId}, ${kind}, 'draft', ${id}, ${scratch.subsidiaryId},
            ${scratch.customerId}, '2026-07-01', '2026-07-20', 'CAD', '1', ${total}, 0, ${total}, ${actor})`)
        await db.execute(sql`insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, ${total}, ${total}, 0, ${total})`)
        await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
        const entry = await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
        const line = (await db.execute<{ id: string }>(sql`select id from journal_lines
          where entry_id = ${entry} and is_open_item`)).rows[0]!.id
        return { id, line }
      }
      const inv = await postDoc('customer_invoice', '100')
      const credit = await postDoc('customer_credit', '60')
      async function apply(fromLine: string, toLine: string, amount: string, ref: string): Promise<void> {
        const pay = randomUUID()
        if (fromLine === credit.line) {
          await db.execute(sql`insert into applications
            (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
             source_transaction_currency, target_transaction_amount, target_transaction_currency,
             settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
            values (${scratch.orgId}, ${fromLine}, ${toLine}, ${amount}, '2026-07-12', ${amount}, ${amount},
              'CAD', ${amount}, 'CAD', '1', 'same_currency', ${ref}, ${actor}, ${actor})`)
          return
        }
        await db.execute(sql`insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'BAL-PAY', '2026-07-12',
            ${scratch.periodId}, 'pay', 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
          values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${scratch.customerId},
              ${amount}, 'CAD', ${amount}, '1', false),
                 (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, ${scratch.customerId},
              -${amount}::numeric, 'CAD', -${amount}::numeric, '1', true)`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
        const payLine = (await db.execute<{ id: string }>(sql`select id from journal_lines
          where entry_id = ${pay} and is_open_item`)).rows[0]!.id
        await db.execute(sql`insert into applications
          (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
           source_transaction_currency, target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
          values (${scratch.orgId}, ${payLine}, ${toLine}, ${amount}, '2026-07-12', ${amount}, ${amount},
            'CAD', ${amount}, 'CAD', '1', 'same_currency', ${ref}, ${actor}, ${actor})`)
      }
      await apply('', inv.line, '40', 'DRAWER-PAY-TEST')
      await apply(credit.line, inv.line, '25', 'DRAWER-CREDIT-TEST')
      return { inv: inv.id, credit: credit.id }
    })
    // Reads run in the scratch org's scope: importing a web reader replaces
    // the test bypass, so an unscoped read silently returns zero rows.
    await withOrgContext(scratch.orgId, async () => {
      const invDrawer = await loadDocument(ids.inv, scratch.orgId)
      assert.equal(String(invDrawer!.doc.applied), '65.0000')
      assert.equal(String(invDrawer!.doc.balance_due), '35.0000')
      const creditDrawer = await loadDocument(ids.credit, scratch.orgId)
      assert.equal(String(creditDrawer!.doc.applied), '25.0000')
      assert.equal(String(creditDrawer!.doc.balance_due), '35.0000')
      // PDF values are locale money-formatted: pin the number through the
      // formatting rather than the exact glyphs.
      const invPdf = await loadPdfRecordValues('customer_invoice', scratch.orgId, ids.inv)
      assert.match(String(invPdf!.values.balance_due), /35[.,]00/)
      const creditPdf = await loadPdfRecordValues('customer_credit', scratch.orgId, ids.credit)
      assert.match(String(creditPdf!.values.balance_due), /35[.,]00/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
