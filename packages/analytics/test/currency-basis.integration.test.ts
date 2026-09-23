// Currency-basis regression: jl.amount is each subsidiary's FUNCTIONAL
// currency, so a base-money sum across subsidiaries with different base
// currencies blends denominations, as does a txn-money sum across document
// currencies. Ungrouped blends must refuse naming the remedy; grouping by
// the denomination lets labeled rows flow. Runs in the integration
// partition with a migrated database:
//   node --import tsx --import ./engine/src/testing/database-bypass.ts \
//     --test packages/analytics/test/currency-basis.integration.test.ts
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
const { InsightDenominationError, runInsightQuery } = await import('../src/execute')

const TAG_BASE = 'G8CURR-BASE-'
const TAG_TXN = 'G8CURR-TXN-'

type Scratch = {
  orgId: string
  subsidiaryId: string
  periodId: string
  bookId: string
  accounts: { bank: string; revenue: string }
  date: string
}

/** Balanced entry; amount legs are base money, txn legs document currency. */
async function postEntry(
  scratch: Scratch,
  opts: {
    subId: string
    currency: string
    bankAmount: string
    bankTxn: string
    fxRate?: string
    tag: string
  },
): Promise<void> {
  // jl_fx_consistent: |amount − round(txn_amount × fx_rate, 4)| ≤ 0.005.
  const fxRate = opts.fxRate ?? '1'
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, origin, posted_at)
    values
      (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${opts.subId},
       ${opts.tag}, ${scratch.date}, ${scratch.periodId},
       ${opts.tag}, 'draft', 'manual', null)`)
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id,
       amount, currency, txn_amount, fx_rate)
    values
      (${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank},
       ${opts.subId}, ${opts.bankAmount}, ${opts.currency}, ${opts.bankTxn}, ${fxRate}),
      (${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.revenue},
       ${opts.subId}, ${'-' + opts.bankAmount.replace(/^-/, '')}, ${opts.currency},
       ${'-' + opts.bankTxn.replace(/^-/, '')}, ${fxRate})`)
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now()
     where id = ${entryId}`)
}

const incomeLeg = (tag: string) => [
  { field: 'entry_number', op: 'contains', value: tag },
  { field: 'account_type', op: 'eq', value: 'income' },
]

test('a base-money sum across two base currencies refuses; grouped it flows', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = (await withBypass(() => createScratchOrg())) as unknown as Scratch
  try {
    const euSubId = randomUUID()
    // One root (parentless) subsidiary per org — the second subsidiary hangs
    // off the root.
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${euSubId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'EU Co', 'EUR', 'DE', '{}'::jsonb, false, true, '{}'::jsonb)`))
    await withBypass(() => postEntry(scratch, { subId: scratch.subsidiaryId, currency: 'CAD', bankAmount: '100.0000', bankTxn: '100.0000', tag: TAG_BASE + 'CAD' }))
    await withBypass(() => postEntry(scratch, { subId: euSubId, currency: 'EUR', bankAmount: '200.0000', bankTxn: '200.0000', tag: TAG_BASE + 'EUR' }))

    const base = {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: incomeLeg(TAG_BASE),
    } as const
    const scope = { org: scratch.orgId, subs: [scratch.subsidiaryId, euSubId], book: [scratch.bookId] }

    // Ungrouped, the CAD and EUR legs would blend into one meaningless total.
    await assert.rejects(
      runInsightQuery(pool, base, scope.org, scope.subs, undefined, scratch.date, scope.book),
      (e: unknown) => {
        assert.ok(e instanceof InsightDenominationError)
        assert.match(e.message, /functional currencies/)
        assert.match(e.message, /Base currency/)
        return true
      },
    )

    // Grouped by base currency, each denomination flows with its own label —
    // and the guard columns never leak into the result rows.
    const partitioned = await runInsightQuery(
      pool,
      { ...base, dimensions: [{ field: 'base_currency' }] },
      scope.org,
      scope.subs,
      undefined,
      scratch.date,
      scope.book,
    )
    assert.equal(partitioned.rowCount, 2)
    assert.deepEqual(
      partitioned.rows
        .map((r) => [String(r.base_currency), String(r.sum_amount)])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
      [['CAD', '-100.0000'], ['EUR', '-200.0000']],
    )
    for (const row of partitioned.rows) {
      assert.ok(Object.keys(row).every((k) => !k.startsWith('__')), 'census columns must not leak into results')
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('a txn-money sum across two document currencies refuses; grouped it flows', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = (await withBypass(() => createScratchOrg())) as unknown as Scratch
  try {
    await withBypass(() => postEntry(scratch, { subId: scratch.subsidiaryId, currency: 'CAD', bankAmount: '500.0000', bankTxn: '500.0000', tag: TAG_TXN + 'CAD' }))
    // 300 USD at 1.3333333333 books 400.0000 CAD: round(300 × 1.3333333333, 4).
    await withBypass(() => postEntry(scratch, { subId: scratch.subsidiaryId, currency: 'USD', bankAmount: '400.0000', bankTxn: '300.0000', fxRate: '1.3333333333', tag: TAG_TXN + 'USD' }))

    const base = {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'txn_amount' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: incomeLeg(TAG_TXN),
    } as const
    const scope = { org: scratch.orgId, subs: [scratch.subsidiaryId], book: [scratch.bookId] }

    await assert.rejects(
      runInsightQuery(pool, base, scope.org, scope.subs, undefined, scratch.date, scope.book),
      (e: unknown) => {
        assert.ok(e instanceof InsightDenominationError)
        assert.match(e.message, /transaction currencies/)
        assert.match(e.message, /Currency/)
        return true
      },
    )

    const partitioned = await runInsightQuery(
      pool,
      { ...base, dimensions: [{ field: 'currency' }] },
      scope.org,
      scope.subs,
      undefined,
      scratch.date,
      scope.book,
    )
    assert.equal(partitioned.rowCount, 2)
    assert.deepEqual(
      partitioned.rows
        .map((r) => [String(r.currency), String(r.sum_txn_amount)])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
      [['CAD', '-500.0000'], ['USD', '-300.0000']],
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
