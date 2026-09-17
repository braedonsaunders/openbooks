import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { agingByParty, agingDetail } = await import('./reports/aging')

/**
 * An aging "as of" a past date must reconstruct what was open THEN: a
 * September settlement of an August invoice must not erase it from the
 * August aging. The live open_balance already reflects the settlement, so
 * the as-of open is gross lines minus applications dated on/before as-of
 * (an application unapplied after as-of still counted then).
 */
test('aging as-of reconstructs opens before later settlements', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Aging Controller', 'admin'))
    await withBypass(async () => {
      const id = randomUUID()
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
          ${scratch.customerId}, ${scratch.date}, 'CAD', '1', 100, 0, 100, ${actor})`)
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, 100, 100, 0, 100)`)
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
      const entry = await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      const invLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${entry} and is_open_item`)).rows[0]!.id
      // Settle in full AFTER the August as-of: a September dated application.
      const pay = randomUUID()
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${pay}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId}, 'AGING-PAY', '2026-09-10', ${scratch.periodId}, 'pay', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values (${scratch.orgId}, ${pay}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${scratch.customerId}, '100', 'CAD', '100', '1', false),
               (${scratch.orgId}, ${pay}, 2, ${scratch.accounts.ar}, ${scratch.subsidiaryId}, ${scratch.customerId}, '-100', 'CAD', '-100', '1', true)`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${pay}`)
      const payLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where entry_id = ${pay} and is_open_item`)).rows[0]!.id
      await db.execute(sql`insert into applications
        (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
         source_transaction_currency, target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference)
        values (${scratch.orgId}, ${payLine}, ${invLine}, '100', '2026-09-10', '100', '100', 'CAD', '100', 'CAD',
          '1', 'same_currency', 'AGING-TEST')`)
      // Live open is now settled …
      const live = (await db.execute<{ open_balance: string }>(sql`select open_balance::text from documents where id = ${id}`)).rows[0]!
      assert.equal(live.open_balance, '0.0000')
    })
    // … but the August aging must still show the invoice as open. Reads run
    // in the scratch org's scope: importing the aging reader pulls in the
    // web request-org resolver, which denies every query outside an explicit
    // scope (pooled RLS), so a bare read sees zero rows.
    const asOf = '2026-08-31'
    await withOrgContext(scratch.orgId, async () => {
      const aging = await agingByParty('ar', asOf, undefined, scratch.orgId)
      assert.equal(aging.rows.length, 1)
      assert.equal(aging.totals.total, '100.0000')
      const detail = await agingDetail('ar', asOf, undefined, scratch.orgId)
      assert.equal(detail.rows.length, 1)
      assert.equal(detail.totals.total, '100.0000')
      // And a September as-of agrees with the settled live balance.
      const sept = await agingByParty('ar', '2026-09-30', undefined, scratch.orgId)
      assert.equal(sept.totals.total, '0.0000')
      assert.equal(sept.rows.length, 0)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
