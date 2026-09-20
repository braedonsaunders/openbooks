import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { agingByParty, agingDetail, agingCurrenciesInScope } = await import('./aging')

/**
 * Aging answers two different questions and must label which one it is
 * answering. A EUR 100 invoice posted when EUR/CAD was 1.2345678901 carries
 * a stored base open of 123.4568; after a EUR 40 part-payment the live cache
 * reads 60 EUR. With the as-of spot moved to 1.5:
 * - base basis rebuilds 74.0741 CAD from stored base amounts (ties the GL,
 *   immune to the rate move);
 * - transaction basis rebuilds 60 EUR from stored txn legs and converts at
 *   the as-of spot to 90.0000 CAD (what the customer owes, expressed in CAD).
 * Detail rows always carry the document currency and the unconverted txn
 * open, whatever basis is selected. A same-currency (CAD) document reads
 * identically under both bases.
 */
test('aging converts from base or transaction currency at the as-of spot', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Aging Controller', 'admin'))
    const eur = randomUUID()
    const cad = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${eur}, ${scratch.orgId}, 'customer_invoice', 'draft', ${eur}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'EUR', '1.2345678901', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${eur}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${cad}, ${scratch.orgId}, 'customer_invoice', 'draft', ${cad}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 200, 0, 200, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${cad}, 1, ${scratch.accounts.revenue}, 1, 200, 200, 0, 200)`)
      await db.execute(sql`update documents set status = 'approved' where id in (${eur}, ${cad})`)
      await postDocument(eur, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      await postDocument(cad, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      // EUR 40 same-currency part-payment: base leg 40 x 1.2345678901 = 49.3827.
      const pay = randomUUID()
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'BASIS-PAY', ${scratch.date}, ${scratch.periodId}, 'pay', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${scratch.customerId}, '49.3827', 'EUR', '40', '1.2345678901', false),
               (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, ${scratch.customerId}, '-49.3827', 'EUR', '-40', '1.2345678901', true)`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
      const invLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = (select posted_entry_id from documents where id = ${eur}) and is_open_item`)).rows[0]!.id
      const payLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${pay} and is_open_item`)).rows[0]!.id
      await db.execute(sql`insert into applications
        (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
         source_transaction_currency, target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference)
        values (${scratch.orgId}, ${payLine}, ${invLine}, '49.3827', ${scratch.date}, '49.3827', '40', 'EUR', '40', 'EUR',
          '1', 'same_currency', 'BASIS-TEST')`)
      // The as-of spot moves AFTER posting: stored base amounts must not move
      // with it, while the transaction basis converts through it.
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
        values (${scratch.orgId}, 'EUR', 'CAD', ${scratch.date}, 'spot', '1.5')`)
    })
    await withOrgContext(scratch.orgId, async () => {
      const live = (await db.execute<{ id: string; open_balance: string }>(sql`
        select id::text as id, open_balance::text as open_balance from documents where id in (${eur}, ${cad})`)).rows
      assert.equal(live.find((d) => d.id === eur)?.open_balance, '60.0000')

      // Default is the base basis in the org base: the numbers booked to date.
      const base = await agingByParty('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(base.basis, 'base')
      assert.equal(base.reportingCurrency, 'CAD')
      // 123.4568 - 49.3827 + 200: stored base legs, immune to the 1.5 spot.
      assert.equal(base.totals.total, '274.0741')

      const txn = await agingByParty('ar', scratch.date, undefined, scratch.orgId, { basis: 'transaction' })
      assert.equal(txn.basis, 'transaction')
      assert.equal(txn.reportingCurrency, 'CAD')
      // 60 x 1.5 + 200: txn legs converted at the as-of spot.
      assert.equal(txn.totals.total, '290.0000')

      const detail = await agingDetail('ar', scratch.date, undefined, scratch.orgId, { basis: 'transaction' })
      assert.equal(detail.rows.length, 2)
      const eurRow = detail.rows.find((r) => r.docId === eur)!
      assert.equal(eurRow.docCurrency, 'EUR')
      assert.equal(eurRow.txnOpen, '60.0000')
      assert.equal(eurRow.open, '90.0000')
      const cadRow = detail.rows.find((r) => r.docId === cad)!
      assert.equal(cadRow.docCurrency, 'CAD')
      assert.equal(cadRow.txnOpen, '200.0000')
      assert.equal(cadRow.open, '200.0000')

      // Same-currency documents read identically under both bases.
      const baseDetail = await agingDetail('ar', scratch.date, undefined, scratch.orgId)
      assert.equal(baseDetail.rows.find((r) => r.docId === cad)?.open, '200.0000')
      assert.equal(baseDetail.rows.find((r) => r.docId === eur)?.open, '74.0741')
      assert.equal(baseDetail.rows.find((r) => r.docId === eur)?.txnOpen, '60.0000')

      // The selector offers the base plus in-scope transaction currencies only.
      assert.deepEqual(await agingCurrenciesInScope('ar', scratch.date, undefined, scratch.orgId), {
        baseCurrency: 'CAD',
        currencies: ['CAD', 'EUR'],
      })
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
