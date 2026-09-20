import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Statement rollups must terminate on a malformed account-parent cycle. The
 * account PATCH route refuses cycles (with lock ordering), but the sync
 * migration parents imported accounts with no validation
 * (engine/src/sync/migrate.ts), so a corrupt source file can land A↔B in the
 * ledger. The hierarchy display tolerates that by policy ("must remain
 * visible for correction" — web/lib/account-hierarchy.ts); the balance
 * rollups must at least terminate instead of hanging every P&L and balance
 * sheet org-wide.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { profitAndLoss, balanceSheet } = (await import(root + 'web/lib/reports/statements.ts')) as typeof import('./statements')
const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('../statement-matrix')

async function seedCycle(orgId: string, revenueAccount: string): Promise<void> {
  const a = randomUUID()
  const b = randomUUID()
  const c = randomUUID()
  await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, parent_id)
    values (${a}, ${orgId}, 'P01-A', 'P01 cycle A', 'expense', true, ${b}),
           (${b}, ${orgId}, 'P01-B', 'P01 cycle B', 'expense', true, ${a}),
           (${c}, ${orgId}, 'P01-C', 'P01 cycle leaf', 'expense', false, ${a})`)
  const entry = randomUUID()
  const period = (await db.execute<{ id: string }>(sql`select id from accounting_periods where org_id = ${orgId} limit 1`)).rows[0]!.id
  const book = (await db.execute<{ id: string }>(sql`select id from accounting_books where org_id = ${orgId} and is_primary limit 1`)).rows[0]!.id
  const sub = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${orgId} limit 1`)).rows[0]!.id
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${orgId}, ${book}, ${sub}, 'P01-CYC', '2026-07-05', ${period}, 'cycle probe', 'draft', 'manual')`)
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${orgId}, ${entry}, 1, ${c}, ${sub}, '100.0000', 'CAD', '100.0000', '1', 'x'),
           (${orgId}, ${entry}, 2, ${revenueAccount}, ${sub}, '-100.0000', 'CAD', '-100.0000', '1', 'x')`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
}

test('scalar P&L terminates on an account-parent cycle', { skip: !process.env.OPENBOOKS_DB_URL, timeout: 15_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedCycle(org.orgId, org.accounts.revenue))
    await withOrgContext(org.orgId, async () => {
      const pnl = await profitAndLoss('2026-07-01', '2026-07-31', undefined, org.orgId)
      assert.ok(pnl, 'P&L must return despite the cycle')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('matrix P&L terminates on an account-parent cycle', { skip: !process.env.OPENBOOKS_DB_URL, timeout: 15_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedCycle(org.orgId, org.accounts.revenue))
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-07-01', to: '2026-07-31' },
        periodLabel: 'Jul',
      })
      assert.ok(matrix, 'matrix must return despite the cycle')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('balance sheet terminates on an account-parent cycle', { skip: !process.env.OPENBOOKS_DB_URL, timeout: 15_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => seedCycle(org.orgId, org.accounts.revenue))
    await withOrgContext(org.orgId, async () => {
      const bs = await balanceSheet('2026-07-31', org.orgId)
      assert.ok(bs, 'balance sheet must return despite the cycle')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
