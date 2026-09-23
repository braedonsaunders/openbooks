// Book-basis regression: primary+tax postings must never blend. Runs in the
// integration partition with a migrated database:
//   node --import tsx --import ./engine/src/testing/database-bypass.ts \
//     --test packages/analytics/test/book-basis.integration.test.ts
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, pool, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { runInsightQuery } = await import('../src/execute')

const TAG = 'G8BOOK-GL-'

async function postRevenue(
  scratch: { orgId: string; subsidiaryId: string; periodId: string; accounts: { bank: string; revenue: string }; date: string },
  bookId: string,
  amount: string,
  tag: string,
): Promise<void> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, origin, posted_at)
    values
      (${entryId}, ${scratch.orgId}, ${bookId}, ${scratch.subsidiaryId},
       ${TAG + tag}, ${scratch.date}, ${scratch.periodId},
       ${tag}, 'draft', 'manual', null)`)
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id,
       amount, currency, txn_amount, fx_rate)
    values
      (${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank},
       ${scratch.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
      (${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.revenue},
       ${scratch.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now()
     where id = ${entryId}`)
}

test('insight ledger sums read the primary book, not primary plus tax', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const taxBookId = randomUUID()
    await withBypass(() => db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${taxBookId}, ${scratch.orgId}, 'TAX', 'Tax book', false, true, true)`))
    await withBypass(() => postRevenue(scratch, scratch.bookId, '100.0000', 'PRIMARY'))
    await withBypass(() => postRevenue(scratch, taxBookId, '250.0000', 'TAX'))

    // Each posting is a BALANCED entry (bank +X, revenue −X): summing every
    // line nets to zero in every book, which cannot tell clamping apart from
    // blending. Isolate the revenue leg so the books disagree.
    const base = {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [
        { field: 'entry_number', op: 'contains', value: TAG },
        { field: 'account_type', op: 'eq', value: 'income' },
      ],
    } as const

    // Clamped to the primary book: the tax posting must not leak in.
    const clamped = await runInsightQuery(
      pool,
      base,
      scratch.orgId,
      [scratch.subsidiaryId],
      undefined,
      scratch.date,
      [scratch.bookId],
    )
    assert.equal(clamped.rowCount, 1)
    assert.equal(String(clamped.rows[0]!.sum_amount), '-100.0000')

    // Explicit cross-book analysis partitions by book with each book labeled.
    const partitioned = await runInsightQuery(
      pool,
      { ...base, dimensions: [{ field: 'book' }] },
      scratch.orgId,
      [scratch.subsidiaryId],
      undefined,
      scratch.date,
      null,
    )
    assert.equal(partitioned.rowCount, 2)
    assert.deepEqual(
      partitioned.rows.map((r) => String(r.sum_amount)).sort(),
      ['-100.0000', '-250.0000'],
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
