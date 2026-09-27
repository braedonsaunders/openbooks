import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReportEntity, ReportMeasure } from './types'
import { compileCustomQuery } from './custom-query'
import { evaluateFormulaMeasures } from './formula'
import { shapeSummarizedRows, summarizeRows, type InMemoryReportMeasure } from './run'
import { validateCustomQuery } from './validate'

const entity: ReportEntity = {
  key: 'facts', label: 'Facts', category: 'test', description: 'Test facts', from: 'fact_rows f', orgColumn: 'f.org_id', timeKey: 'period',
  columns: [
    { key: 'period', label: 'Period', kind: 'date', expr: 'f.period' },
    { key: 'week', label: 'Week', kind: 'date', expr: 'f.period' },
    { key: 'month', label: 'Month', kind: 'date', expr: 'f.period' },
    { key: 'subsidiary', label: 'Subsidiary', kind: 'text', expr: 'f.subsidiary' },
    { key: 'status', label: 'Status', kind: 'text', expr: 'f.status' },
    { key: 'segment', label: 'Segment', kind: 'text', expr: 'f.segment' },
    { key: 'amount', label: 'Amount', kind: 'number', expr: 'f.amount' },
    { key: 'billed', label: 'Billed', kind: 'number', expr: 'f.billed' },
    { key: 'capacity', label: 'Capacity', kind: 'number', expr: 'f.capacity' },
    { key: 'balance', label: 'Balance', kind: 'number', expr: 'f.balance' },
  ],
}

function formula(key: string, expr: ReportMeasure['expr'], format: ReportMeasure['format'] = 'ratio', extra: Partial<ReportMeasure> = {}): ReportMeasure {
  return { fn: 'formula', key, label: key, expr, format, ...extra }
}

test('formula arithmetic stays rational until one half-away-from-zero rounding', () => {
  const measures = [
    { fn: 'sum', key: 'top', column: 'amount' },
    { fn: 'sum', key: 'bottom', column: 'amount' },
    formula('ratio', { op: '/', left: { ref: 'top' }, right: { ref: 'bottom' } }),
    formula('percent', { op: '/', left: { ref: 'top' }, right: { ref: 'bottom' } }, 'percent'),
    formula('negative-half', { op: '/', left: { const: '-1' }, right: { const: '2' } }, 'number', { scale: 0 }),
  ] satisfies ReportMeasure[]
  const values = evaluateFormulaMeasures(measures, ['1', '3'])
  assert.equal(values[2]?.value, '0.3333')
  assert.equal(values[3]?.value, '33.33')
  assert.equal(values[4]?.value, '-1')
  assert.equal(evaluateFormulaMeasures(measures, ['2', '3'])[2]?.value, '0.6667')
  assert.equal(evaluateFormulaMeasures([
    { fn: 'count', key: 'rows' },
    formula('count-ratio', { op: '/', left: { ref: 'rows' }, right: { const: '2' } }),
  ], [3])[1]?.value, '1.5000')
})

test('zero denominators and guards return named undefined reasons', () => {
  const measures = [
    { fn: 'sum', key: 'denominator', column: 'amount' },
    formula('division', { op: '/', left: { const: '5' }, right: { ref: 'denominator' } }),
    formula('guarded', { op: '/', left: { const: '5' }, right: { const: '2' } }, 'ratio', {
      guards: [{ measure: 'denominator', when: 'zero', label: 'No denominator' }],
    }),
  ] satisfies ReportMeasure[]
  const zero = evaluateFormulaMeasures(measures, ['0'])
  assert.equal(zero[1]?.undefinedLabel, 'Undefined — divides by zero')
  assert.equal(zero[2]?.undefinedLabel, 'No denominator')
  assert.equal(evaluateFormulaMeasures(measures, ['2'])[1]?.value, '2.5000')
})

test('validation names unknown refs, cycles, invalid money units, denomination blends and missing time keys', () => {
  const validate = (measures: ReportMeasure[], subject = entity) => validateCustomQuery({
    entity: subject.key, mode: 'summarize', columns: [], measures,
  }, { [subject.key]: subject })
  assert.throws(() => validate([formula('bad-ref', { ref: 'missing' })]), /bad-ref.*unknown measure 'missing'/)
  assert.throws(() => validate([formula('bad-guard', { const: '1' }, 'number', {
    guards: [{ measure: 'missing', when: 'zero', label: 'No value' }],
  })]), /bad-guard.*guard for unknown measure 'missing'/)
  assert.throws(() => validate([
    formula('first', { ref: 'second' }), formula('second', { ref: 'first' }),
  ]), /cycle/)
  const moneyEntity = { ...entity, columns: entity.columns.map((column) => column.key === 'amount' ? { ...column, kind: 'money' as const } : column) }
  assert.throws(() => validate([
    { fn: 'sum', key: 'a', column: 'amount' }, { fn: 'sum', key: 'b', column: 'amount' },
    formula('product', { op: '*', left: { ref: 'a' }, right: { ref: 'b' } }, 'money'),
  ], moneyEntity), /product.*multiply money by money/)
  const currencies = { ...moneyEntity, columns: moneyEntity.columns.map((column) => column.key === 'amount'
    ? { ...column, txnCurrency: true }
    : column).concat([{ key: 'base', label: 'Base', kind: 'money' as const, expr: 'f.base', baseMoney: true }]) }
  assert.throws(() => validate([
    { fn: 'sum', key: 'txn', column: 'amount' }, { fn: 'sum', key: 'base', column: 'base' },
    formula('mixed', { op: '/', left: { ref: 'txn' }, right: { ref: 'base' } }),
  ], currencies), /mixed.*incompatible denominations/)
  assert.throws(() => validate([{ fn: 'opening', column: 'amount' }], { ...entity, timeKey: undefined }), /opening.*no time key/)
})

test('filtered measures and semi-additive values compile into their shared SQL forms', () => {
  const plan = validateCustomQuery({
    entity: entity.key,
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'period', bin: 'month' }],
    measures: [
      { fn: 'sum', key: 'billed', column: 'billed', filter: { combinator: 'and', rules: [{ field: 'status', op: 'eq', value: 'posted' }] } },
      { fn: 'opening', key: 'opening', column: 'balance' },
      formula('rate', { op: '/', left: { ref: 'billed' }, right: { const: '2' } }),
    ],
    sorts: [{ column: 'rate', direction: 'asc' }],
  }, { facts: entity })
  const compiled = compileCustomQuery(entity, plan, 'org-id')
  assert.match(compiled.text, /MIN\("__time"\) OVER \(PARTITION BY "d0"\)/)
  assert.match(compiled.text, /SUM\("__v0"\) FILTER \(WHERE "__f0"\)/)
  assert.match(compiled.text, /ORDER BY .*NULLS LAST, 1 ASC/)
  assert.deepEqual(compiled.values, ['org-id', 'posted'])
})

test('a legacy saved summarize query keeps its SQL byte-for-byte shape', () => {
  const compiled = compileCustomQuery(entity, {
    entity: 'facts', mode: 'summarize', columns: [],
    breakouts: [{ column: 'segment' }], measures: [{ fn: 'sum', column: 'amount' }],
  }, 'org-id')
  assert.equal(compiled.text,
    'SELECT f.segment AS "d0", SUM(f.amount) AS "m0" FROM fact_rows f WHERE f.org_id = $1 GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 1000')
  assert.deepEqual(compiled.values, ['org-id'])
})

test('in-memory weekly aggregates filter components and shape a ratio of totals', () => {
  const rows = [
    { period: '2026-01-05', week: '2026-01-05', subsidiary: 'A', status: 'billable', billed: '2', capacity: '4', balance: '10' },
    { period: '2026-01-06', week: '2026-01-05', subsidiary: 'B', status: 'other', billed: '4', capacity: '4', balance: '20' },
    { period: '2026-01-08', week: '2026-01-05', subsidiary: 'A', status: 'billable', billed: '3', capacity: '6', balance: '11' },
    { period: '2026-01-09', week: '2026-01-05', subsidiary: 'B', status: 'billable', billed: '1', capacity: '2', balance: '21' },
  ]
  const measures = [
    { fn: 'sum', key: 'billed', column: 'billed', filter: (row: Readonly<Record<string, unknown>>) => row.status === 'billable' },
    { fn: 'sum', key: 'capacity', column: 'capacity' },
    formula('utilization', { op: '/', left: { ref: 'billed' }, right: { ref: 'capacity' } }, 'percent'),
    { fn: 'opening', key: 'opening', column: 'balance' },
    { fn: 'closing', key: 'closing', column: 'balance' },
  ] satisfies InMemoryReportMeasure[]
  const plan = { entity, breakouts: [{ column: 'week', bin: 'week' as const }, { column: 'subsidiary' }], measures }
  const raw = summarizeRows(rows, plan)
  const shaped = shapeSummarizedRows(raw, plan)
  assert.deepEqual(raw.map((row) => [row.d0, row.d1, row.m0, row.m1, row.m2, row.m3, row.m4]), [
    ['2026-01-05T00:00:00.000Z', 'A', '5', '10', null, '10', '11'],
    ['2026-01-05T00:00:00.000Z', 'B', '1', '6', null, '20', '21'],
  ])
  assert.equal(shaped.groups[0]?.rows[0]?.[4], '50.00%')
  assert.equal(shaped.summary.find((item) => item.label === 'Total utilization')?.value, '37.50%')
})

test('opening and closing add across subsidiaries by month and use first/last time sections', () => {
  const rows = [
    ['2026-01-02', 'A', '10'], ['2026-01-30', 'A', '15'], ['2026-01-03', 'B', '20'], ['2026-01-30', 'B', '25'],
    ['2026-02-02', 'A', '30'], ['2026-02-28', 'A', '35'], ['2026-02-03', 'B', '40'], ['2026-02-28', 'B', '45'],
    ['2026-03-02', 'A', '50'], ['2026-03-30', 'A', '55'], ['2026-03-03', 'B', '60'], ['2026-03-30', 'B', '65'],
  ].map(([period, subsidiary, balance]) => ({ period, month: period, subsidiary, balance }))
  const plan = {
    entity,
    breakouts: [{ column: 'month', bin: 'month' as const }, { column: 'subsidiary' }],
    groupBy: 'subsidiary',
    totals: { grand: true },
    measures: [
      { fn: 'opening', key: 'opening', column: 'balance' },
      { fn: 'closing', key: 'closing', column: 'balance' },
    ] satisfies InMemoryReportMeasure[],
  }
  const result = shapeSummarizedRows(summarizeRows(rows, plan), plan)
  const grand = result.groups.find((group) => group.title === 'Grand totals')
  assert.ok(grand)
  assert.deepEqual(grand.rows, [
    ['2026-01', '30', '40'], ['2026-02', '70', '80'], ['2026-03', '110', '120'],
  ])

  const timePlan = {
    entity,
    breakouts: [{ column: 'period' }],
    groupBy: 'period',
    totals: { grand: true },
    measures: plan.measures,
  }
  const timeRows = [
    { period: '2026-01-01', balance: '30' }, { period: '2026-01-31', balance: '40' },
  ]
  const timeResult = shapeSummarizedRows(summarizeRows(timeRows, timePlan), timePlan)
  assert.deepEqual(timeResult.groups.find((group) => group.title === 'Grand totals')?.rows, [['30', '40']])
})
