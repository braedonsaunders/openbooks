import assert from 'node:assert/strict'
import test from 'node:test'
import { compileInsightQuery } from '../src/compile.ts'

test('compileInsightQuery honors a sort ref naming a binned dimension field', () => {
  // The seeded "Revenue by month" card sorts by its dimension's catalog field
  // (`posting_date`), not the binned output alias (`posting_date_month`). The
  // as-of sits just past New Year so the trailing 365 days cross a year
  // boundary — the case a mis-resolved sort gets wrong in both directions.
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit', alias: 'revenue' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [
        { field: 'account_type', op: 'in', value: ['income', 'income_other'] },
        { field: 'posting_date', op: 'last_n_days', value: 365 },
      ],
      sort: [{ ref: 'posting_date', dir: 'asc' }],
    },
    'org-1',
    {},
    '2026-01-15',
    null,
  )
  assert.match(compiled.sql, /order by 1 asc nulls last/)
})

test('compileInsightQuery still prefers an explicit output alias for sorts', () => {
  // Widening sort refs to field keys must not steal refs that already name
  // an output alias: the alias keeps winning.
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit', alias: 'revenue' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [{ field: 'account_type', op: 'in', value: ['income'] }],
      sort: [{ ref: 'revenue', dir: 'desc' }],
    },
    'org-1',
    {},
    '2026-09-18',
    null,
  )
  assert.match(compiled.sql, /order by 2 desc nulls last/)
})

test('compileInsightQuery refuses a stale sort reference instead of using the default order', () => {
  assert.throws(
    () => compileInsightQuery(
      {
        source: 'ledger_lines',
        measures: [{ agg: 'sum', field: 'credit', alias: 'revenue' }],
        dimensions: [{ field: 'posting_date', bin: 'month' }],
        sort: [{ ref: 'deleted_customer_name', dir: 'asc' }],
      },
      'org-1',
      {},
      '2026-09-18',
      null,
      null,
    ),
    /sort reference 'deleted_customer_name' no longer resolves/,
  )
})

test('compileInsightQuery emits valid SQL for not_in filters', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      filters: [{ field: 'party_name', op: 'not_in', value: ['Excluded'] }],
    },
    'org-1',
    {},
    '2026-09-18',
    null,
  )

  assert.match(compiled.sql, /p\.display_name <> all\(\$2\)/)
  assert.doesNotMatch(compiled.sql, /not\s*=\s*any/i)
  assert.deepEqual(compiled.params, ['org-1', ['Excluded']])
})

test('compileInsightQuery keeps an empty not_in filter as a no-op', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      filters: [{ field: 'party_name', op: 'not_in', value: [] }],
    },
    'org-1',
    {},
    '2026-09-18',
    null,
  )

  assert.match(compiled.sql, /where jl\.org_id = \$1 and true/)
  assert.deepEqual(compiled.params, ['org-1'])
})

test('Insights applies the report catalog subsidiary policy to every source', async () => {
  const { REPORT_ENTITIES } = await import('@openbooks/reports')
  for (const entity of REPORT_ENTITIES) {
    const scope = ['11111111-1111-4111-8111-111111111111']
    const compiled = compileInsightQuery({ source: entity.key }, 'org-1', {}, '2026-09-04', scope)
    const empty = compileInsightQuery({ source: entity.key }, 'org-1', {}, '2026-09-04', [])
    assert.match(empty.sql, / and FALSE/, entity.key)
    if (entity.subsidiaryScope) {
      assert.ok(compiled.sql.includes(`${entity.subsidiaryScope.column} = ANY($2::uuid[])`), entity.key)
      assert.deepEqual(compiled.params[1], scope)
      if (entity.subsidiaryScope.sharedNull) {
        assert.ok(compiled.sql.includes(`(${entity.subsidiaryScope.column} IS NULL OR `), entity.key)
      }
    } else {
      assert.equal(entity.subsidiaryScope, null, 'shared sources must explicitly declare that policy')
    }
  }
})

test('Insights source discovery enforces permissions and authoritative feature gates together', async () => {
  const { allowedSources } = await import('../src/catalog.ts')
  const sources = allowedSources((permission) => permission !== 'payroll.read', (feature) => !['projects', 'timeTracking'].includes(feature))
  assert.ok(sources.some((source) => source.key === 'documents'))
  assert.ok(!sources.some((source) => ['projects', 'timesheets', 'pay_stubs'].includes(source.key)))
})

test('a binned temporal dimension defaults to chronological order, not measure rank', () => {
  // The REAL "Revenue by month" card in production stores `sort: []`. With no
  // ref to resolve, the default took over — measure desc — so a twelve-month
  // revenue line rendered in descending revenue order and always sloped down.
  // A time series is chronological; ranking is for "top N by measure".
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [
        { field: 'account_type', op: 'in', value: ['income', 'income_other'] },
        { field: 'posting_date', op: 'last_n_days', value: 365 },
      ],
      sort: [],
      limit: null,
    },
    '00000000-0000-0000-0000-000000000001',
    {},
    '2026-09-18',
    null,
  )
  const order = /order by ([^\n]*)/.exec(compiled.sql)?.[1] ?? ''
  assert.match(order, /^1 asc/, `expected the month dimension first ascending, got: ${order}`)
  assert.doesNotMatch(order, /desc/, `a time series must not be ranked by measure: ${order}`)

  const month = compiled.columns.find((c) => c.role === 'dimension')
  assert.equal(month?.dateBin, 'month', 'the bin must reach the renderer to label the period')
})

test('an unbinned dimension still ranks by the measure', () => {
  // The chronological default must not swallow the ranking default: "top
  // accounts by amount" is a ranking and stays measure-desc.
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'credit' }],
      dimensions: [{ field: 'account_type' }],
      filters: [],
      sort: [],
      limit: null,
    },
    '00000000-0000-0000-0000-000000000001',
    {},
    '2026-09-18',
    null,
  )
  assert.match(/order by ([^\n]*)/.exec(compiled.sql)?.[1] ?? '', /desc/)
})
