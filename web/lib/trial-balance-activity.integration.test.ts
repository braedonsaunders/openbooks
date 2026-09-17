import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { trialBalance } = await import('./reports/statements.ts')

/**
 * F-t08-002: the trial balance is headed "accounts with activity" but dropped
 * zero-balance accounts with real postings (Rassaun 1055 Investments: 5 FY
 * lines incl. a CA$905k credit leg, closed at CA$0.00), understating gross
 * debit/credit flows. Every account with postings must appear with its
 * debit/credit legs on both TB paths (summary-backed and line-backed).
 */
test('trial balance keeps zero-balance accounts that had activity', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const washId = randomUUID()
    const deptId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type)
        values (${washId}, ${scratch.orgId}, '1997', 'Wash Account', 'asset_current_other')`)
      await db.execute(sql`insert into departments (id, org_id, name)
        values (${deptId}, ${scratch.orgId}, 'Wash Department')`)
      // A wash: debits = credits = 500, closing balance zero — the 1055 shape.
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'WASH-1', ${scratch.date}, ${scratch.periodId}, 'wash', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${entry}, 1, ${washId}, ${scratch.subsidiaryId}, ${deptId}, '500', 'CAD', '500', '1'),
               (${scratch.orgId}, ${entry}, 2, ${washId}, ${scratch.subsidiaryId}, ${deptId}, '-500', 'CAD', '-500', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
    })

    const asOf = scratch.date
    const summaryRows = await withBypassContext(() => trialBalance(asOf, undefined, scratch.orgId))
    const wash = summaryRows.find((r) => r.number === '1997')
    assert.ok(wash, 'zero-balance wash account appears on the summary path')
    assert.equal(wash.debits, '500.0000')
    assert.equal(wash.credits, '500.0000')

    const lineRows = await withBypassContext(() => trialBalance(asOf, { departmentId: deptId }, scratch.orgId))
    const washDept = lineRows.find((r) => r.number === '1997')
    assert.ok(washDept, 'zero-balance wash account appears on the line path')
    assert.equal(washDept.debits, '500.0000')
    assert.equal(washDept.credits, '500.0000')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
