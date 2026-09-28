import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITIES, type ReportEntity } from './entities'
import type { ReportMeasure } from './types'
import { compileCustomQuery } from './custom-query'
import { evaluateFormulaMeasures } from './formula'
import { shapeSummarizedRows, summarizeRows, type InMemoryReportMeasure } from './run'
import {
  canAddAggregateMeasure,
  MAX_AGGREGATE_MEASURES,
  MAX_FORMULA_MEASURES,
  validateCustomQuery,
} from './validate'
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

function formula(key: string, expr: ReportMeasure['expr'], format: ReportMeasure['format'] = 'ratio', extra: Partial<ReportMeasure> = {}): Omit<ReportMeasure, 'filter'> {
  return { fn: 'formula', key, label: key, expr, format, ...extra }
}

test('the report builder caps aggregates independently from formulas', () => {
  const aggregates = Array.from({ length: MAX_AGGREGATE_MEASURES }, (_, index) => ({ fn: 'count' as const, key: `rows_${index}` }))
  const formulas = [formula('ratio_a', { ref: 'rows_0' }), formula('ratio_b', { ref: 'rows_0' })]
  assert.equal(canAddAggregateMeasure([...aggregates.slice(0, -1), ...formulas]), true)
  assert.equal(canAddAggregateMeasure([...aggregates, ...formulas]), false)
})

test('query limits refuse overflow and preserve every measure, breakout and sort at each limit', () => {
  const aggregates = Array.from({ length: MAX_AGGREGATE_MEASURES }, (_, index) => ({
    fn: 'count' as const, key: `aggregate_${index}`,
  }))
  const formulas = Array.from({ length: MAX_FORMULA_MEASURES }, (_, index) => formula(`formula_${index}`, {
    op: '/', left: { ref: 'aggregate_0' }, right: { const: '2' },
  }))
  const breakouts = ['period', 'week', 'month', 'subsidiary', 'status', 'segment'].map((column) => ({ column }))
  const sorts = ['period', 'week', 'month'].map((column) => ({ column, direction: 'asc' as const }))
  const exactPlan = validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [], breakouts, measures: [...aggregates, ...formulas], sorts,
  }, { [entity.key]: entity })
  assert.equal(exactPlan.measures?.length, MAX_AGGREGATE_MEASURES + MAX_FORMULA_MEASURES)
  assert.equal(exactPlan.measures?.at(-1)?.key, `formula_${MAX_FORMULA_MEASURES - 1}`)
  assert.equal(exactPlan.breakouts?.length, 6)
  assert.equal(exactPlan.breakouts?.at(-1)?.column, 'segment')
  assert.equal(exactPlan.sorts?.length, 3)
  assert.equal(exactPlan.sorts?.at(-1)?.column, 'month')

  const fourFormulaPlan = validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [],
    measures: [...aggregates, ...formulas.slice(0, 4)],
  }, { [entity.key]: entity })
  assert.equal(fourFormulaPlan.measures?.length, MAX_AGGREGATE_MEASURES + 4)
  assert.equal(fourFormulaPlan.measures?.at(-1)?.key, 'formula_3')

  assert.throws(() => validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [], measures: [...aggregates, { fn: 'count', key: 'aggregate_8' }],
  }, { [entity.key]: entity }), new RegExp(`at most ${MAX_AGGREGATE_MEASURES} aggregate measures; this one has ${MAX_AGGREGATE_MEASURES + 1}`))
  assert.throws(() => validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [], measures: [
      { fn: 'count', key: 'aggregate_0' }, ...formulas,
      formula('formula_8', { op: '/', left: { ref: 'aggregate_0' }, right: { const: '2' } }),
    ],
  }, { [entity.key]: entity }), new RegExp(`at most ${MAX_FORMULA_MEASURES} formula measures; this one has ${MAX_FORMULA_MEASURES + 1}`))
  assert.throws(() => validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [], breakouts: [...breakouts, { column: 'amount' }],
  }, { [entity.key]: entity }), /at most 6 breakouts; this one has 7/)
  assert.throws(() => validateCustomQuery({
    entity: entity.key, mode: 'summarize', columns: [], sorts: [...sorts, { column: 'subsidiary', direction: 'asc' }],
  }, { [entity.key]: entity }), /at most 3 sort levels; this one has 4/)
})

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

test('in-memory summaries omit mixed-denomination money and keep exact single-currency totals', () => {
  const moneyEntity: ReportEntity = {
    key: 'money_facts', label: 'Money facts', category: 'test', description: 'Test money facts',
    from: 'money_rows m', orgColumn: 'm.org_id', timeKey: 'period', currencyColumn: 'currency',
    columns: [
      { key: 'period', label: 'Period', kind: 'date', expr: 'm.period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'm.currency' },
      { key: 'revenue', label: 'Revenue', kind: 'money', expr: 'm.revenue', txnCurrency: true },
      { key: 'cost', label: 'Cost', kind: 'money', expr: 'm.cost', txnCurrency: true },
    ],
  }
  const measures = [
    { fn: 'sum', key: 'revenue', column: 'revenue' },
    { fn: 'sum', key: 'cost', column: 'cost' },
    { fn: 'count', key: 'rows', label: 'Rows' },
    formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', { label: 'Margin' }),
    formula('margin_percent', { op: '/', left: { ref: 'margin' }, right: { ref: 'revenue' } }, 'percent', { label: 'Margin percent' }),
  ] satisfies InMemoryReportMeasure[]
  const shape = (rows: Record<string, unknown>[]) => {
    const plan = { entity: moneyEntity, breakouts: [{ column: 'currency' }], measures }
    return shapeSummarizedRows(summarizeRows(rows, plan), plan, rows)
  }
  const labels = (result: ReturnType<typeof shape>) => result.summary.map((item) => item.label)

  const mixed = shape([
    { period: '2026-01-05', currency: 'USD', revenue: '10.0000', cost: '6.0000' },
    { period: '2026-01-05', currency: 'CAD', revenue: '20.0000', cost: '12.0000' },
  ])
  assert.equal(mixed.groups[0]?.rows.length, 2, 'per-currency group rows stay partitioned')
  assert.deepEqual(labels(mixed), ['Groups', 'Total rows'], 'no blended money or margin card')
  assert.equal(mixed.summary.find((item) => item.label === 'Total rows')?.value, 2)

  const single = shape([
    { period: '2026-01-05', currency: 'USD', revenue: '10.0000', cost: '6.0000' },
    { period: '2026-01-06', currency: 'USD', revenue: '20.0000', cost: '12.0000' },
  ])
  const values = new Map(single.summary.map((item) => [item.label, item.value]))
  assert.equal(values.get('Total sum of revenue'), '30.00')
  assert.equal(values.get('Total sum of cost'), '18.00')
  assert.equal(values.get('Total margin'), '12.0000')
  assert.equal(values.get('Total margin percent'), '40.00%')
})

test('in-memory book singularity uses the canonical row key and missing evidence fails closed', () => {
  const bookEntity: ReportEntity = {
    key: 'book_facts', label: 'Book facts', category: 'test', description: 'Test book facts',
    from: 'book_rows b', orgColumn: 'b.org_id', timeKey: 'period',
    currencyColumn: 'currency', bookScope: { column: 'b.book_id' },
    columns: [
      { key: 'period', label: 'Period', kind: 'date', expr: 'b.period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'b.currency' },
      { key: 'book_id', label: 'Book (id)', kind: 'uuid', expr: 'b.id' },
      { key: 'revenue', label: 'Revenue', kind: 'money', expr: 'b.revenue', txnCurrency: true },
      { key: 'cost', label: 'Cost', kind: 'money', expr: 'b.cost', txnCurrency: true },
    ],
  }
  const measures = [
    { fn: 'sum', key: 'revenue', column: 'revenue' },
    { fn: 'sum', key: 'cost', column: 'cost' },
    { fn: 'count', key: 'rows', label: 'Rows' },
    formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', { label: 'Margin' }),
  ] satisfies InMemoryReportMeasure[]
  const shape = (
    rows: Record<string, unknown>[],
    entity: ReportEntity = bookEntity,
    breakouts: { column: string }[] = [{ column: 'currency' }, { column: 'book_id' }],
  ) => {
    const plan = { entity, breakouts, measures }
    return shapeSummarizedRows(summarizeRows(rows, plan), plan, rows)
  }
  const labels = (result: ReturnType<typeof shape>) => result.summary.map((item) => item.label)

  // One shared book on every row stays exact. The SQL scope 'b.book_id' never
  // matches a row key, so exact totals prove observation used row.book_id.
  const oneBook = shape([
    { period: '2026-01-05', currency: 'USD', book_id: 'book-one', revenue: '10.0000', cost: '6.0000' },
    { period: '2026-01-06', currency: 'USD', book_id: 'book-one', revenue: '20.0000', cost: '12.0000' },
  ])
  assert.equal(oneBook.summary.find((item) => item.label === 'Total sum of revenue')?.value, '30.00')
  assert.equal(oneBook.summary.find((item) => item.label === 'Total margin')?.value, '12.0000')

  // Two books under one currency: partitioned groups stay, combined cards go.
  const twoBooks = shape([
    { period: '2026-01-05', currency: 'USD', book_id: 'book-one', revenue: '10.0000', cost: '6.0000' },
    { period: '2026-01-05', currency: 'USD', book_id: 'book-two', revenue: '20.0000', cost: '12.0000' },
  ])
  assert.equal(twoBooks.groups[0]?.rows.length, 2)
  assert.deepEqual(labels(twoBooks), ['Groups', 'Total rows'])

  // A scoped entity whose catalog row cannot expose the book fails closed.
  const unkeyedEntity: ReportEntity = {
    ...bookEntity,
    columns: (bookEntity.columns ?? []).filter((column) => column.key !== 'book_id'),
  }
  const missingBook = shape(
    [{ period: '2026-01-05', currency: 'USD', revenue: '10.0000', cost: '6.0000' }],
    unkeyedEntity,
    [{ column: 'currency' }],
  )
  assert.deepEqual(labels(missingBook), ['Groups', 'Total rows'])

  // A declared currency with no observable value fails closed: all missing,
  // null, and partially missing evidence alike.
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    period: '2026-01-05', currency: 'USD', book_id: 'book-one',
    revenue: '10.0000', cost: '6.0000', ...overrides,
  })
  for (const rows of [
    [row({ currency: undefined })],
    [row({ currency: null })],
    [row({ currency: '' })],
    [row({}), row({ currency: undefined })],
  ]) {
    assert.deepEqual(labels(shape(rows, bookEntity, [{ column: 'book_id' }])), ['Groups', 'Total rows'])
  }

  // Zero contributors are vacuously single: the empty money cards publish.
  const empty = shape([], bookEntity, [{ column: 'currency' }])
  assert.ok(labels(empty).includes('Total sum of revenue'))
})

test('every book-scoped catalog entity exposes the canonical in-memory book key', () => {
  const missing = REPORT_ENTITIES.filter((entity) => entity.bookScope
    && !(entity.columns ?? []).some((column) => column.key === 'book_id'))
  assert.deepEqual(missing.map((entity) => entity.key), [])
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

test('book contributor book_id evidence fails closed unless one exact book', () => {
  const bookEntity: ReportEntity = {
    key: 'book_facts', label: 'Book facts', category: 'test', description: 'Test book facts',
    from: 'book_rows b', orgColumn: 'b.org_id', timeKey: 'period',
    currencyColumn: 'currency', bookScope: { column: 'b.book_id' },
    columns: [
      { key: 'period', label: 'Period', kind: 'date', expr: 'b.period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'b.currency' },
      { key: 'book_id', label: 'Book (id)', kind: 'uuid', expr: 'b.id' },
      { key: 'revenue', label: 'Revenue', kind: 'money', expr: 'b.revenue', txnCurrency: true },
      { key: 'cost', label: 'Cost', kind: 'money', expr: 'b.cost', txnCurrency: true },
    ],
  }
  const measures = [
    { fn: 'sum', key: 'revenue', column: 'revenue' },
    { fn: 'sum', key: 'cost', column: 'cost' },
    { fn: 'count', key: 'rows', label: 'Rows' },
    formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', { label: 'Margin' }),
  ] satisfies InMemoryReportMeasure[]
  const shape = (rows: Record<string, unknown>[]) => {
    const plan = { entity: bookEntity, breakouts: [{ column: 'book_id' }], measures }
    return shapeSummarizedRows(summarizeRows(rows, plan), plan, rows)
  }
  const labels = (result: ReturnType<typeof shape>) => result.summary.map((item) => item.label)
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    period: '2026-01-05', currency: 'USD', book_id: 'book-one',
    revenue: '10.0000', cost: '6.0000', ...overrides,
  })

  // Every shape of missing book evidence fails closed on a valid book-scoped
  // entity: absent key, null, undefined, and blank all omit money cards.
  for (const rows of [
    [{ period: '2026-01-05', currency: 'USD', revenue: '10.0000', cost: '6.0000' }],
    [row({ book_id: undefined })],
    [row({ book_id: null })],
    [row({ book_id: '' })],
    [row({ book_id: '   ' })],
    [row({}), row({ book_id: undefined })],
  ]) {
    assert.deepEqual(labels(shape(rows)), ['Groups', 'Total rows'])
  }

  // Two books under one scope: partitioned groups stay, combined cards go.
  const mixed = shape([row({}), row({ book_id: 'book-two' })])
  assert.equal(mixed.groups[0]?.rows.length, 2)
  assert.deepEqual(labels(mixed), ['Groups', 'Total rows'])

  // One shared book on every contributor stays exact.
  const exact = shape([row({}), row({ period: '2026-01-06', revenue: '20.0000', cost: '12.0000' })])
  assert.equal(exact.summary.find((item) => item.label === 'Total sum of revenue')?.value, '30.00')
  assert.equal(exact.summary.find((item) => item.label === 'Total margin')?.value, '12.0000')
})

test('aggregate rows without contributors omit money cards but keep counts', () => {
  const moneyEntity: ReportEntity = {
    key: 'money_facts', label: 'Money facts', category: 'test', description: 'Test money facts',
    from: 'money_rows m', orgColumn: 'm.org_id', timeKey: 'period', currencyColumn: 'currency',
    columns: [
      { key: 'period', label: 'Period', kind: 'date', expr: 'm.period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'm.currency' },
      { key: 'revenue', label: 'Revenue', kind: 'money', expr: 'm.revenue', txnCurrency: true },
      { key: 'cost', label: 'Cost', kind: 'money', expr: 'm.cost', txnCurrency: true },
    ],
  }
  const measures = [
    { fn: 'sum', key: 'revenue', column: 'revenue' },
    { fn: 'sum', key: 'cost', column: 'cost' },
    { fn: 'count', key: 'rows', label: 'Rows' },
    formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', { label: 'Margin' }),
    formula('margin_percent', { op: '/', left: { ref: 'margin' }, right: { ref: 'revenue' } }, 'percent', { label: 'Margin percent' }),
  ] satisfies InMemoryReportMeasure[]
  const plan = { entity: moneyEntity, breakouts: [{ column: 'currency' }], measures }
  const inputs = [
    { period: '2026-01-05', currency: 'USD', revenue: '10.0000', cost: '6.0000' },
    { period: '2026-01-06', currency: 'USD', revenue: '20.0000', cost: '12.0000' },
  ]
  // The same aggregate rows shaped WITH contributors publish money cards, so
  // the omission below proves withheld observation — not the inputs.
  const observed = shapeSummarizedRows(summarizeRows(inputs, plan), plan, inputs)
  assert.ok(observed.summary.some((item) => item.label === 'Total sum of revenue'))

  // Aggregates passed with no contributing rows fail closed: monetary and
  // money-derived cards are omitted while partitioned groups and the safe
  // count card survive.
  const withheld = shapeSummarizedRows(summarizeRows(inputs, plan), plan)
  assert.equal(withheld.groups[0]?.rows.length, 1)
  assert.deepEqual(withheld.summary.map((item) => item.label), ['Groups', 'Total rows'])
  assert.equal(withheld.summary.find((item) => item.label === 'Total rows')?.value, 2)
})

test('single-currency zero revenue publishes the divide-by-zero refusal, never a ratio', () => {
  const moneyEntity: ReportEntity = {
    key: 'money_facts', label: 'Money facts', category: 'test', description: 'Test money facts',
    from: 'money_rows m', orgColumn: 'm.org_id', timeKey: 'period', currencyColumn: 'currency',
    columns: [
      { key: 'period', label: 'Period', kind: 'date', expr: 'm.period' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'm.currency' },
      { key: 'revenue', label: 'Revenue', kind: 'money', expr: 'm.revenue', txnCurrency: true },
      { key: 'cost', label: 'Cost', kind: 'money', expr: 'm.cost', txnCurrency: true },
    ],
  }
  const measures = [
    { fn: 'sum', key: 'revenue', column: 'revenue' },
    { fn: 'sum', key: 'cost', column: 'cost' },
    { fn: 'count', key: 'rows', label: 'Rows' },
    formula('margin', { op: '-', left: { ref: 'revenue' }, right: { ref: 'cost' } }, 'money', { label: 'Margin' }),
    formula('margin_percent', { op: '/', left: { ref: 'margin' }, right: { ref: 'revenue' } }, 'percent', { label: 'Margin percent' }),
  ] satisfies InMemoryReportMeasure[]
  // Fully priced (cost present) yet revenue-free: margin is exact zero and the
  // margin ratio has no denominator.
  const inputs = [{ period: '2026-01-05', currency: 'USD', revenue: '0.0000', cost: '0.0000' }]
  const plan = { entity: moneyEntity, breakouts: [], measures }
  const result = shapeSummarizedRows(summarizeRows(inputs, plan), plan, inputs)
  const card = result.summary.find((item) => item.label === 'Total margin percent')
  assert.equal(card?.value, 'Undefined — divides by zero')
  assert.ok(!/^-?\d/.test(String(card?.value ?? '')), 'refusal must not read as a numeric ratio')
})
