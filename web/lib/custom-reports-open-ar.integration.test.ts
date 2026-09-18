import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * F-t07-007: built-in "Open AR by customer" filtered on is_open_item, which
 * marks AR-tracked lines — not unpaid ones — so paid invoices and their
 * payment lines counted as open (28 vs the aging detail's 16) and the oldest
 * due date min()ed over stale rows. It must count only application-aware
 * open lines, and date measures must render as dates.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, pool, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
// runCustomQuery directly: the web executeReport wrapper needs a Next
// request scope (cookies) for locale/feature prep, which tests lack.
const { runCustomQuery } = (await import(root + 'packages/reports/src/run.ts')) as typeof import('@openbooks/reports')
const { REPORT_ENTITY_MAP } = (await import(root + 'packages/reports/src/entities.ts')) as typeof import('@openbooks/reports')
const { BUILT_IN_REPORT_DEFINITION_MAP } = (await import(root + 'packages/reports/src/built-ins.ts')) as typeof import('@openbooks/reports')

type Org = Awaited<ReturnType<typeof createScratchOrg>>

async function postArEntry(
  org: Org,
  entryNumber: string,
  lines: { accountId: string; amount: string; dueDate: string | null }[],
): Promise<string[]> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber},
       ${org.date}, ${org.periodId}, ${entryNumber}, 'draft', 'manual')`)
  // One multi-row INSERT (the balance trigger reads the whole entry).
  const values = lines.map(
    (line, index) =>
      sql`(${org.orgId}, ${entryId}, ${index + 1}, ${line.accountId}, ${org.subsidiaryId}, ${org.customerId}, ${line.amount}, 'CAD', ${line.amount}, '1', ${line.dueDate}, true)`,
  )
  const all = values.reduce((acc, v, i) => (i === 0 ? v : sql`${acc}, ${v}`))
  const inserted = await db.execute<{ id: string }>(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, due_date, is_open_item)
    values ${all}
    returning id`)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  return inserted.rows.map((row) => row.id)
}

async function applyPayment(org: Org, fromLineId: string, toLineId: string, amount: string) {
  await db.execute(sql`
    insert into applications
      (id, org_id, from_line_id, to_line_id, amount, source_amount,
       source_transaction_amount, source_transaction_currency,
       target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on)
    values
      (${randomUUID()}, ${org.orgId}, ${fromLineId}, ${toLineId}, ${amount}, ${amount},
       ${amount}, 'CAD', ${amount}, 'CAD', '1', 'same_currency', 't07-007', ${org.date})`)
}

test('open AR counts only unpaid lines and renders dates as dates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      // Invoice A $1000 due 06-30: unpaid.
      await postArEntry(org, 'JE-AR-A', [
        { accountId: org.accounts.ar, amount: '1000', dueDate: '2026-06-30' },
        { accountId: org.accounts.revenue, amount: '-1000', dueDate: null },
      ])
      // Invoice B $500 due 07-31: paid in full by payment line P.
      const [, lineBAr] = await postArEntry(org, 'JE-AR-B', [
        { accountId: org.accounts.revenue, amount: '-500', dueDate: null },
        { accountId: org.accounts.ar, amount: '500', dueDate: '2026-07-31' },
      ])
      const [lineP] = await postArEntry(org, 'JE-AR-P', [
        { accountId: org.accounts.ar, amount: '-500', dueDate: null },
        { accountId: org.accounts.bank, amount: '500', dueDate: null },
      ])
      await applyPayment(org, lineP!, lineBAr!, '500')
      // Invoice C $800 due 07-15: partially paid $300.
      const [, lineCAr] = await postArEntry(org, 'JE-AR-C', [
        { accountId: org.accounts.revenue, amount: '-800', dueDate: null },
        { accountId: org.accounts.ar, amount: '800', dueDate: '2026-07-15' },
      ])
      const [lineQ] = await postArEntry(org, 'JE-AR-Q', [
        { accountId: org.accounts.ar, amount: '-300', dueDate: null },
        { accountId: org.accounts.bank, amount: '300', dueDate: null },
      ])
      await applyPayment(org, lineQ!, lineCAr!, '300')
    })
    const def = BUILT_IN_REPORT_DEFINITION_MAP['open-ar-by-customer']
    assert.ok(def, 'open-ar-by-customer must exist')
    const result = await withOrgContext(org.orgId, () =>
      runCustomQuery(pool, def.query, { orgId: org.orgId, entityMap: REPORT_ENTITY_MAP }),
    )
    const group = result.groups[0]
    assert.ok(group, 'one customer group expected')
    // Columns: Party | Open balance (base) | Open lines | Oldest due date.
    const balanceIdx = group.columns.findIndex((c) => String(c).toLowerCase().includes('balance'))
    const linesIdx = group.columns.findIndex((c) => String(c).toLowerCase().includes('lines'))
    const dueIdx = group.columns.findIndex((c) => String(c).toLowerCase().includes('due'))
    assert.ok(balanceIdx >= 0 && linesIdx >= 0 && dueIdx >= 0, `expected balance/lines/due columns, got ${JSON.stringify(group.columns)}`)
    const row = group.rows[0]!
    assert.equal(Number(row[balanceIdx]), 1500, 'open balance = unpaid + remaining partial')
    assert.equal(Number(row[linesIdx]), 2, 'only lines with remaining balance count (paid invoice + consumed payments excluded)')
    assert.equal(row[dueIdx], '2026-06-30', 'oldest due date renders as a date, never a datetime')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
