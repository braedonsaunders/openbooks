import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { CustomerPulseSections } from './customer-pulse.ts'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { postDocument } = await import('@openbooks/engine/src/ledger/posting-document.ts')
const { loadCustomerPulse } = await import('./customer-pulse.ts')

const AR_ONLY: CustomerPulseSections = { ar: true, crm: false, projects: false }

/**
 * Ledger money aggregates as exact decimal strings through the pulse — never
 * floats. 0.10 + 0.20 is "0.3000" (floats give 0.30000000000000004), amounts
 * above 2^53 keep their cents, and credit headroom subtracts exactly.
 */
test('customer pulse keeps money exact through aggregation and JSON', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Pulse Precision', 'admin'))
    const bigParty = randomUUID()
    const bigEntry = randomUUID()
    const bigDoc = randomUUID()
    // Large magnitude with exact cents: numeric(19,4) storage and its monthly
    // rollups cap below 10^15, so the test stays inside the domain — but
    // 123456789012345.6789 carries 19 significant digits, past f64's ~16, so
    // parseFloat loses the trailing cents while decimal text keeps them.
    const HUGE = '123456789012345.6789'
    const NEG_HUGE = '-123456789012345.6789'
    await withBypass(async () => {
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, credit_limit, currency)
        values (${scratch.orgId}, ${scratch.customerId}, 10000, 'CAD')`)
      for (const [id, amount] of [[randomUUID(), '0.10'], [randomUUID(), '0.20']] as const) {
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total, created_by)
          values (${id}, ${scratch.orgId}, 'customer_invoice', 'draft', ${id}, ${scratch.subsidiaryId},
            ${scratch.customerId}, ${scratch.date}, 'CAD', '1', ${amount}, 0, ${amount}, ${actor})`)
        await db.execute(sql`insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
          values (${scratch.orgId}, ${id}, 1, ${scratch.accounts.revenue}, 1, ${amount}, ${amount}, 0, ${amount})`)
        await db.execute(sql`update documents set status = 'approved' where id = ${id}`)
        await postDocument(id, { control: { ar: scratch.accounts.ar, ap: scratch.accounts.ap, bank: scratch.accounts.bank } })
      }
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${bigParty}, ${scratch.orgId}, 'customer', 'Huge Customer', true, '{}'::jsonb)`)
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${bigEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'HUGE-1', ${scratch.date}, ${scratch.periodId}, 'HUGE-1', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values (${scratch.orgId}, ${bigEntry}, 1, ${scratch.accounts.ar}, ${scratch.subsidiaryId},
          ${HUGE}, 'CAD', ${HUGE}, '1', ${bigParty}, true, 'HUGE-1'),
          (${scratch.orgId}, ${bigEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId},
          ${NEG_HUGE}, 'CAD', ${NEG_HUGE}, '1', null, false, 'HUGE-1')`)
      // openItems joins entries to documents through the source link; link the
      // draft entry before posting (posted entries are immutable).
      await db.execute(sql`insert into documents
        (id, org_id, kind, document_number, document_date, posting_date, currency, fx_rate,
         subtotal, tax_total, total, party_id, status, posted_entry_id, posting_period_id, open_balance, subsidiary_id)
        values (${bigDoc}, ${scratch.orgId}, 'customer_invoice', 'HUGE-1', ${scratch.date}, ${scratch.date},
          'CAD', '1', ${HUGE}, '0.0000', ${HUGE}, ${bigParty}, 'draft', ${bigEntry}, ${scratch.periodId}, ${HUGE}, ${scratch.subsidiaryId})`)
      await db.execute(sql`update journal_entries set source_document_id = ${bigDoc} where id = ${bigEntry}`)
      // Lines of a posted entry are immutable: post the entry after its lines.
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${bigEntry}`)
      await db.execute(sql`update documents set status = 'posted' where id = ${bigDoc}`)
    })

    await withOrgContext(scratch.orgId, async () => {
      const small = await loadCustomerPulse(scratch.customerId, scratch.orgId, null, AR_ONLY)
      assert.ok(small?.aging)
      assert.equal(small.aging.totalOpen, '0.3000')
      assert.equal(small.aging.current, '0.3000')
      assert.equal(small.credit?.openArBalance, '0.3000')
      assert.equal(small.credit?.remainingCredit, '9999.7000')
      assert.equal(small.party.creditLimit, '10000.0000')

      const big = await loadCustomerPulse(bigParty, scratch.orgId, null, AR_ONLY)
      assert.ok(big?.aging)
      assert.equal(big.aging.totalOpen, HUGE)
      assert.equal(big.credit?.openArBalance, HUGE)
    })
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
