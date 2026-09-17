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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { statementMatrix } = await import('./statement-matrix')

/**
 * Breakout columns must come from the same posted set the aggregation reads.
 * A draft entry tagging an otherwise-inactive department must not mint a
 * zero-valued column (which, at the 24-column cap, can displace a real one),
 * and draft-only untagged lines must not mint an "Unassigned" column.
 */
test('department breakout ignores draft entries when discovering columns', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const deptA = randomUUID(), deptB = randomUUID()
    const postEntry = randomUUID(), draftEntry = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into departments (id, org_id, name, is_active)
        values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true),
               (${deptB}, ${scratch.orgId}, 'ZZZ Draft Dept', true)`)
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
          (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
          (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
          (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptB}, '50', 'CAD', '50', '1'),
          (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptB}, '-50', 'CAD', '-50', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
    })
    // Scoped like the cash-basis precision case (F-coord-005): the web
    // request-org resolver denies unscoped reads under pooled RLS, so a bare
    // call returns zero rows and mints no columns at all.
    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
      orgId: scratch.orgId, types: ['income'], mode: 'flow',
      period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
      breakout: 'department',
    })))
    assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
    assert.equal(matrix.truncated, false)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('department breakout ignores draft-only untagged lines for the Unassigned column', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const deptA = randomUUID()
    const postEntry = randomUUID(), draftEntry = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into departments (id, org_id, name, is_active)
        values (${deptA}, ${scratch.orgId}, 'AAA Posted Dept', true)`)
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${postEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'MATRIX-POSTED', ${scratch.date}, ${scratch.periodId}, 'posted', 'draft', 'manual'),
          (${draftEntry}, ${scratch.orgId}, ${scratch.bookId}, ${scratch.subsidiaryId},
          'MATRIX-DRAFT', ${scratch.date}, ${scratch.periodId}, 'draft', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${postEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, ${deptA}, '100', 'CAD', '100', '1'),
          (${scratch.orgId}, ${postEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, ${deptA}, '-100', 'CAD', '-100', '1'),
          (${scratch.orgId}, ${draftEntry}, 1, ${scratch.accounts.bank}, ${scratch.subsidiaryId}, null, '50', 'CAD', '50', '1'),
          (${scratch.orgId}, ${draftEntry}, 2, ${scratch.accounts.revenue}, ${scratch.subsidiaryId}, null, '-50', 'CAD', '-50', '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${postEntry}`)
    })
    const matrix = await withBypass(() => withOrgContext(scratch.orgId, async () => statementMatrix({
      orgId: scratch.orgId, types: ['income'], mode: 'flow',
      period: { from: '2026-07-01', to: '2026-07-31' }, periodLabel: 'July 2026',
      breakout: 'department',
    })))
    assert.deepEqual(matrix.columns.map((c) => c.label), ['AAA Posted Dept'])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
