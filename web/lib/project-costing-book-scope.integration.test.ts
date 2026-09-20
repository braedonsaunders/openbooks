import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { projectCostSummary } = await import('./project-costing.ts')

test('project cost actuals and account detail stay in the primary book', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const secondaryBook = randomUUID()
    const project = randomUUID()
    await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBook}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`)
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, contract_value)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BOOK-SCOPE', 'Book scope project', ${org.customerId}, 'active', true, '0')`)

    async function post(bookId: string, amount: string, tag: string) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId}, 'project cost', 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${project}, ${amount}, 'CAD', ${amount}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, null, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
    }

    await post(org.bookId, '100', 'PRIMARY-COST')
    await post(secondaryBook, '900', 'TAX-COST')

    const summary = await projectCostSummary(org.orgId, project)
    assert.equal(summary.actual.cost, '100.0000')
    assert.deepEqual(summary.costByAccount.map((row) => ({ accountId: row.accountId, amount: row.amount })), [
      { accountId: org.accounts.cogs, amount: '100.0000' },
    ])
  } finally { await dropScratchOrg(org.orgId) }
})
