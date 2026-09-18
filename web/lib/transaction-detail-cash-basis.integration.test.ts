import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Cash-basis statement cells recognize accrual documents at their settled
 * share (the matrix's settlement-share cash logic), but the ledger drill-down
 * behind those cells only listed entries that themselves touch a bank account —
 * so a partially paid invoice's revenue never appeared and the drill net could
 * not tie to the clicked cell. The drill must mirror the matrix engine.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { toUnits } = (await import(root + 'engine/src/money.ts')) as typeof import('@openbooks/engine/src/money.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')
const { transactionDetail } = (await import(root + 'web/lib/reports/transaction-detail.ts')) as typeof import('./reports/transaction-detail')

test('cash-basis drill-down ties to the cash-basis statement cell', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, 'Cash drill writer', 'admin')
      const invoiceLine = randomUUID()
      const paymentLine = randomUUID()
      const paymentArLine = randomUUID()
      const invoice = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${invoice}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CASH-INV-1', '2026-07-05', ${org.periodId}, 'CASH-INV-1', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${invoiceLine}, ${org.orgId}, ${invoice}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, true, '1000.0000', 'CAD', '1000.0000', '1'),
               (${randomUUID()}, ${org.orgId}, ${invoice}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${org.customerId}, false, '-1000.0000', 'CAD', '-1000.0000', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${invoice}`)
      const payment = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${payment}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CASH-PAY-1', '2026-07-10', ${org.periodId}, 'CASH-PAY-1', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${paymentLine}, ${org.orgId}, ${payment}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.customerId}, false, '600.0000', 'CAD', '600.0000', '1'),
               (${paymentArLine}, ${org.orgId}, ${payment}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, ${org.customerId}, true, '-600.0000', 'CAD', '-600.0000', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${payment}`)
      await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on, created_by, updated_by)
        values (${org.orgId}, ${paymentArLine}, ${invoiceLine}, '600.0000', '600.0000', '600.0000', 'CAD', '600.0000', 'CAD', '1', 'same_currency', 'cash drill tie-out', '2026-07-10', ${actor}, ${actor})`)
    })
    await withOrgContext(org.orgId, async () => {
      const period = { from: '2026-07-01', to: '2026-07-31' }
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period,
        periodLabel: 'July 2026',
        basis: 'cash',
      })
      const revenue = matrix.rows.find((r) => r.type === 'income')
      assert.ok(revenue, 'expected a revenue row')
      assert.equal(toUnits(String(revenue.values[0])), toUnits('600.0000'), 'cash basis recognizes the 60% settled share')

      const drill = await transactionDetail({
        orgId: org.orgId,
        accountTypes: ['income', 'income_other'],
        from: period.from,
        to: period.to,
        mode: 'flow',
        basis: 'cash',
      })
      assert.equal(toUnits(String(drill.net)), toUnits('600.0000'), 'cash-basis drill net ties to the cash-basis cell')

      // Accrual drill is unchanged: the full invoice.
      const accrual = await transactionDetail({
        orgId: org.orgId,
        accountTypes: ['income', 'income_other'],
        from: period.from,
        to: period.to,
        mode: 'flow',
        basis: 'accrual',
      })
      assert.equal(toUnits(String(accrual.net)), toUnits('1000.0000'))
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
