import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * RP3 — the indirect cash flow's summary-backed net-income and cash legs
 *       treated an EMPTY subsidiary allowlist (a restricted reader with
 *       nothing visible) as "no filter" and reported org-wide figures.
 * RP4 — the direct cash flow read every accounting book while its proof
 *       balances came from the primary book only, so a parallel book's mirror
 *       entries doubled the sections and broke the tie-out.
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
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { cashFlow, cashFlowIndirect, generalLedger } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')

test('cash flow statements answer for one book and fail closed on an empty subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const taxBookId = randomUUID()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax book', false, true, true)`)
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
      const junePeriodId = randomUUID()
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${junePeriodId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${calendar.fiscal_calendar_id})`)
      const post = async (bookId: string, date: string, periodId: string, amount: string, tag: string) => {
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${tag}, ${date}, ${periodId}, ${tag}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
      // Opening cash in June, July activity in the primary book, and a tax-book
      // mirror of the July activity (parallel book, same amount).
      await post(org.bookId, '2026-06-15', junePeriodId, '40.0000', 'CF-OPENING')
      await post(org.bookId, org.date, org.periodId, '100.0000', 'CF-PRIMARY')
      await post(taxBookId, org.date, org.periodId, '100.0000', 'CF-TAX-MIRROR')
    })
    await withOrgContext(org.orgId, async () => {
      const from = '2026-07-01', to = '2026-07-31'

      // RP4 — primary book by default: the mirror never reaches the sections.
      const primary = await cashFlow(from, to, undefined, org.orgId)
      const income = primary.sections.find((s) => s.section === 'operating')!.lines.find((l) => l.type === 'income')
      assert.equal(toUnits(income?.amount ?? '0'), toUnits('100.0000'), 'direct cash flow fused the tax book into operating income')
      assert.equal(toUnits(primary.openingCash), toUnits('40.0000'))
      assert.equal(toUnits(primary.closingCash), toUnits('140.0000'))
      assert.equal(toUnits(primary.reconciliationGap), 0n, `direct cash flow must tie: gap ${primary.reconciliationGap}`)
      // An explicit book reads that book everywhere (sections and proof legs).
      const tax = await cashFlow(from, to, undefined, org.orgId, taxBookId)
      assert.equal(toUnits(tax.netChange), toUnits('100.0000'))
      assert.equal(toUnits(tax.openingCash), 0n)
      assert.equal(toUnits(tax.closingCash), toUnits('100.0000'))
      assert.equal(toUnits(tax.reconciliationGap), 0n)
      const indirectTax = await cashFlowIndirect(from, to, undefined, org.orgId, taxBookId)
      assert.equal(toUnits(indirectTax.netIncome), toUnits('100.0000'))
      assert.equal(toUnits(indirectTax.reconciliationGap), 0n)

      // RP3 — an empty allowlist reads NOTHING on every leg (summary path).
      const none = await cashFlowIndirect(from, to, { subsidiaryIds: [] }, org.orgId)
      assert.equal(toUnits(none.netIncome), 0n, `empty scope reported org-wide net income ${none.netIncome}`)
      assert.equal(toUnits(none.openingCash), 0n, `empty scope reported org-wide opening cash ${none.openingCash}`)
      assert.equal(toUnits(none.closingCash), 0n, `empty scope reported org-wide closing cash ${none.closingCash}`)
      assert.equal(toUnits(none.netChange), 0n)
      const noneDirect = await cashFlow(from, to, { subsidiaryIds: [] }, org.orgId)
      assert.equal(toUnits(noneDirect.closingCash), 0n)
      assert.equal(toUnits(noneDirect.netChange), 0n)
      // The same scope, non-empty, still reads the entity's own figures.
      const scoped = await cashFlowIndirect(from, to, { subsidiaryIds: [org.subsidiaryId] }, org.orgId)
      assert.equal(toUnits(scoped.netIncome), toUnits('100.0000'))
      assert.equal(toUnits(scoped.openingCash), toUnits('40.0000'))
      assert.equal(toUnits(scoped.reconciliationGap), 0n)
      // General ledger opening balances (summary leg) under the same scopes.
      const glScoped = await generalLedger(from, to, { dims: { subsidiaryIds: [org.subsidiaryId] }, orgId: org.orgId })
      assert.equal(toUnits(glScoped.accounts.find((a) => a.id === org.accounts.bank)!.opening), toUnits('40.0000'))
      const glNone = await generalLedger(from, to, { dims: { subsidiaryIds: [] }, orgId: org.orgId })
      assert.deepEqual(glNone.accounts, [], 'empty scope must list no ledger activity')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
