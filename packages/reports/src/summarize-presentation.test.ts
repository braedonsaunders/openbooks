import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReportEntity } from './entities'
import { compileCustomQuery } from './custom-query'
import { runCustomQuery } from './run'
import { validateCustomQuery } from './validate'

const ORG = '00000000-0000-4000-8000-000000000001'

const entity: ReportEntity = {
  key: 'stock_moves', label: 'Stock moves', category: 'test', description: 'Test stock moves', from: 'stock_moves s', orgColumn: 's.org_id',
  columns: [
    { key: 'moved_on', label: 'Moved on', kind: 'date', expr: 's.moved_on' },
    { key: 'site', label: 'Site', kind: 'text', expr: 's.site' },
    { key: 'direction', label: 'Direction', kind: 'enum', expr: 's.direction', options: ['in', 'out', 'adjust'] },
    { key: 'line_number', label: 'Line #', kind: 'number', identifier: true, expr: 's.line_number' },
    { key: 'quantity', label: 'Quantity', kind: 'number', expr: 's.quantity' },
    { key: 'value', label: 'Value', kind: 'money', expr: 's.value' },
  ],
}
const entityMap = { [entity.key]: entity }
const plan = (query: Record<string, unknown>) => validateCustomQuery({ entity: entity.key, columns: [], ...query }, entityMap)

test('a summarized report orders by the sort levels it names, enums in catalog order, with the other breakouts as tie-breaks', () => {
  const sorted = compileCustomQuery(entity, plan({
    mode: 'summarize',
    breakouts: [{ column: 'site' }, { column: 'direction' }],
    measures: [{ fn: 'sum', column: 'quantity', key: 'qty' }],
    sorts: [{ column: 'direction', direction: 'desc' }],
  }), ORG)
  assert.match(sorted.text, /ORDER BY array_position\(ARRAY\['in', 'out', 'adjust'\]::text\[\], s\.direction\) DESC NULLS LAST, 1 ASC LIMIT/)
  const byMeasure = compileCustomQuery(entity, plan({
    mode: 'summarize',
    breakouts: [{ column: 'site' }],
    measures: [{ fn: 'count', key: 'moves' }, { fn: 'sum', column: 'quantity', key: 'qty' }],
    sorts: [{ column: 'qty', direction: 'asc' }],
  }), ORG)
  assert.match(byMeasure.text, /ORDER BY 3 ASC NULLS LAST, 1 ASC LIMIT/)
  // With no sort levels a summary keeps ranking by its first measure.
  const ranked = compileCustomQuery(entity, plan({ mode: 'summarize', breakouts: [{ column: 'site' }], measures: [{ fn: 'sum', column: 'quantity' }] }), ORG)
  assert.match(ranked.text, /ORDER BY 2 DESC NULLS LAST LIMIT/)
  // A sectioned summary keeps reading as a ledger, section by section.
  const sectioned = compileCustomQuery(entity, plan({
    mode: 'summarize', groupBy: 'direction',
    breakouts: [{ column: 'direction' }, { column: 'site' }],
    measures: [{ fn: 'sum', column: 'quantity' }],
    sorts: [{ column: 'site', direction: 'desc' }],
  }), ORG)
  assert.match(sectioned.text, /ORDER BY array_position\(ARRAY\['in', 'out', 'adjust'\]::text\[\], s\.direction\) ASC NULLS LAST, 2 ASC LIMIT/)
})

test('omitting zero rows needs a summary of numeric measures and is otherwise refused with a remedy', () => {
  const compiled = compileCustomQuery(entity, plan({
    mode: 'summarize', omitZeroRows: true,
    breakouts: [{ column: 'site' }],
    measures: [{ fn: 'sum', column: 'quantity' }, { fn: 'count' }],
  }), ORG)
  assert.match(compiled.text, /GROUP BY 1 HAVING NOT \(COALESCE\(SUM\(s\.quantity\), 0\) = 0 AND COALESCE\(COUNT\(\*\)::int, 0\) = 0\) ORDER BY/)
  assert.doesNotMatch(compileCustomQuery(entity, plan({ mode: 'summarize', breakouts: [{ column: 'site' }], measures: [{ fn: 'count' }] }), ORG).text, /HAVING/)
  assert.throws(() => plan({ mode: 'rows', columns: ['site'], omitZeroRows: true }), /applies to summarized reports.*turn the option off/)
  assert.throws(
    () => plan({ mode: 'summarize', omitZeroRows: true, breakouts: [{ column: 'site' }], measures: [{ fn: 'max', column: 'moved_on', label: 'Last move' }] }),
    /'Last move' is not a number — remove it or turn the option off/,
  )
})

test('quantity columns are typed for print and spreadsheets, while identifiers, money and percent formulas are not', async () => {
  const client = (rows: Record<string, unknown>[]) => ({ query: async () => ({ rows }) })
  const detail = await runCustomQuery(client([{ site: 'North', line_number: 1204, quantity: '12.5000', value: '10.00' }]), plan({
    mode: 'rows', columns: ['site', 'line_number', 'quantity', 'value'],
  }), { orgId: ORG, entityMap })
  assert.deepEqual(detail.groups[0]!.numberFormats, [null, null, 'number', null])
  assert.deepEqual(detail.groups[0]!.money, [false, false, false, true])

  const summary = await runCustomQuery(client([{ d0: 'North', m0: 3, m1: '12.5', m2: '10.00', m3: '50' }]), plan({
    mode: 'summarize',
    breakouts: [{ column: 'site' }],
    measures: [
      { fn: 'count', key: 'moves' },
      { fn: 'sum', column: 'quantity', key: 'qty' },
      { fn: 'sum', column: 'value', key: 'value' },
      { fn: 'formula', key: 'share', label: 'Share', format: 'percent', expr: { op: '/', left: { ref: 'qty' }, right: { const: '25' } } },
    ],
  }), { orgId: ORG, entityMap })
  assert.deepEqual(summary.groups[0]!.numberFormats, [null, 'number', 'number', null, null])
  assert.deepEqual(summary.groups[0]!.align, ['left', 'right', 'right', 'right', 'right'])
  assert.deepEqual(summary.summary.find((item) => item.label === 'Total sum of quantity'), { label: 'Total sum of quantity', value: '12.50', money: false, number: true })
})
