import assert from 'node:assert/strict'
import test from 'node:test'
import { compileInsightQuery } from '../src/compile'
import { InsightDenominationError, runInsightQuery, type QueryPool } from '../src/execute'

const SUB_A = '00000000-0000-4000-8000-0000000000a1'
const SUB_B = '00000000-0000-4000-8000-0000000000b2'
const PRIMARY = '00000000-0000-4000-8000-000000000011'

/** Mock pool serving canned result rows for the executed SELECT. */
function mockPool(rows: Record<string, unknown>[]): QueryPool {
  return {
    connect: async () => ({
      async query(text: string) {
        return { rows: text.startsWith('select * from') ? rows : [], fields: [] }
      },
      release() {},
    }),
  }
}

const SUM_BASE = {
  source: 'ledger_lines',
  measures: [{ agg: 'sum', field: 'amount' }],
  dimensions: [{ field: 'posting_date', bin: 'month' }],
} as const

test('a base-money sum across two subsidiaries carries a base census', () => {
  const compiled = compileInsightQuery(SUM_BASE, 'org-1', {}, '2026-09-18', [SUB_A, SUB_B], [PRIMARY])
  // The book clamp certifies the book dimension, so only the base probe runs.
  assert.match(compiled.sql, /WITH __denom AS \(SELECT COUNT\(DISTINCT sub\.base_currency\) AS "base_n", MIN\(sub\.base_currency\) AS "base_v" FROM/)
  assert.match(compiled.sql, /\(SELECT "base_n" FROM __denom\) AS "__base_n"/)
  assert.doesNotMatch(compiled.sql, /"txn_n"/)
  assert.doesNotMatch(compiled.sql, /"book_n"/)
  assert.equal(compiled.denomination.hasDenominationCensus, true)
  assert.deepEqual(compiled.denomination.denominationDimensions, ['base'])
  assert.equal(compiled.denomination.baseSingleSubsidiary, false)
  assert.equal(compiled.denomination.bookSingleBasis, true)
})

test('a single-subsidiary scope certifies the base without touching the database', () => {
  const compiled = compileInsightQuery(SUM_BASE, 'org-1', {}, '2026-09-18', [SUB_A], [PRIMARY])
  assert.doesNotMatch(compiled.sql, /__denom/)
  assert.equal(compiled.denomination.hasDenominationCensus, false)
  assert.equal(compiled.denomination.baseSingleSubsidiary, true)
})

test('a base-currency pin certifies the base without a census', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      filters: [{ field: 'base_currency', op: 'eq', value: 'CAD' }],
    },
    'org-1',
    {},
    '2026-09-18',
    [SUB_A, SUB_B],
    [PRIMARY],
  )
  assert.doesNotMatch(compiled.sql, /__denom/)
  assert.equal(compiled.denomination.baseCurrencyPinned, 'CAD')
})

test('a txn-money sum without a currency filter carries a txn census', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'txn_amount' }],
    },
    'org-1',
    {},
    '2026-09-18',
    [SUB_A],
    [PRIMARY],
  )
  assert.match(compiled.sql, /COUNT\(DISTINCT jl\.currency\) AS "txn_n"/)
  assert.deepEqual(compiled.denomination.denominationDimensions, ['txn'])
})

test('a txn-currency pin certifies txn money without a census', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'txn_amount' }],
      filters: [{ field: 'currency', op: 'eq', value: 'CAD' }],
    },
    'org-1',
    {},
    '2026-09-18',
    [SUB_A],
    [PRIMARY],
  )
  assert.doesNotMatch(compiled.sql, /__denom/)
  assert.equal(compiled.denomination.txnCurrencyPinned, 'CAD')
})

test('a binned temporal dimension is never mistaken for a denomination partition', () => {
  // The month bin groups by time, not by money: the census must still probe
  // the base dimension. (Partitioning is by currency/book columns only.)
  const compiled = compileInsightQuery(SUM_BASE, 'org-1', {}, '2026-09-18', [SUB_A, SUB_B], [PRIMARY])
  assert.equal(compiled.denomination.hasDenominationCensus, true)
  const partition = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'base_currency' }],
    },
    'org-1',
    {},
    '2026-09-18',
    [SUB_A, SUB_B],
    [PRIMARY],
  )
  // Partitioning by the denomination still probes (the census rides the same
  // snapshot) — enforcement then lets the labeled per-currency rows flow.
  assert.match(partition.sql, /"base_n"/)
  assert.ok(
    partition.denomination.breakouts.some((b) => b.column === 'base_currency' && !b.bin),
    'the partition breakout must reach enforcement unbinned',
  )
})

test('counts blend no money and carry no census', () => {
  const compiled = compileInsightQuery(
    { source: 'ledger_lines', measures: [{ agg: 'count' }] },
    'org-1',
    {},
    '2026-09-18',
    [SUB_A, SUB_B],
    null,
  )
  assert.doesNotMatch(compiled.sql, /__denom/)
  assert.equal(compiled.denomination.hasDenominationCensus, false)
})

test('the executor refuses a mixed base census and names the remedy', async () => {
  await assert.rejects(
    runInsightQuery(
      mockPool([{ sum_amount: '300.0000', __base_n: 2, __base_v: 'CAD' }]),
      SUM_BASE,
      'org-1',
      [SUB_A, SUB_B],
      undefined,
      '2026-09-18',
      [PRIMARY],
    ),
    (e: unknown) => {
      assert.ok(e instanceof InsightDenominationError)
      assert.match(e.message, /functional currencies/)
      assert.match(e.message, /group by Base currency or filter to one/)
      return true
    },
  )
})

test('the executor fails closed on malformed census evidence', async () => {
  // A result row without its census probe is not evidence of singleness.
  await assert.rejects(
    runInsightQuery(
      mockPool([{ sum_amount: '300.0000' }]),
      SUM_BASE,
      'org-1',
      [SUB_A, SUB_B],
      undefined,
      '2026-09-18',
      [PRIMARY],
    ),
    /invalid denomination evidence/,
  )
})

test('the executor refuses a book-name group that merges two books', async () => {
  // Book display names are not unique: one 'Primary' row spanning two book
  // ids looks partitioned but blends.
  await assert.rejects(
    runInsightQuery(
      mockPool([{ book: 'Primary', sum_amount: '300.0000', __book_n: 2, __book_v: 'x', __book_group_n: 2 }]),
      {
        source: 'ledger_lines',
        measures: [{ agg: 'sum', field: 'amount' }],
        dimensions: [{ field: 'book' }],
      },
      'org-1',
      [SUB_A],
      undefined,
      '2026-09-18',
      null,
    ),
    /group by Book code or Book \(id\)/,
  )
})

test('the default card preview carries an explicit book and base-currency basis', () => {
  // Same shape as DEFAULT_QUERY in web/app/api/insights/cards/route.ts (the
  // blank a fresh studio starts from): ledger_lines SUM(amount) by posting
  // month. A stored plan cannot name a book id, so the BOOK basis arrives
  // from the server allowlist and the BASE basis from the inline census —
  // both must be present in the compiled preview, never silently omitted.
  const compiled = compileInsightQuery(SUM_BASE, 'org-1', {}, '2026-09-18', [SUB_A, SUB_B], [PRIMARY])
  assert.match(compiled.sql, /je\.book_id = ANY\(\$3::uuid\[\]\)/)
  assert.match(compiled.sql, /COUNT\(DISTINCT sub\.base_currency\) AS "base_n"/)
})
