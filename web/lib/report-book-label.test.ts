import assert from 'node:assert/strict'
import test from 'node:test'
import { withReportBookColumn } from './report-book-label'
import type { ExportData } from './report-pdf'

test('CSV book labels retain exact values and leave the source report unchanged', () => {
  const data: ExportData = { title: 'Ledger', dateRangeLabel: 'July', summary: [], groups: [{
    kind: 'results', title: 'Revenue', columns: ['Account', 'Amount'],
    rows: [['4000', '9007199254740993.1234']], money: [false, true], align: ['left', 'right'],
  }] }
  const before = structuredClone(data)
  const labeled = withReportBookColumn(data, { label: 'Book', value: 'TAX · Alternate' })
  assert.deepEqual(labeled.groups[0]?.columns, ['Book', 'Account', 'Amount'])
  assert.deepEqual(labeled.groups[0]?.rows, [['TAX · Alternate', '4000', '9007199254740993.1234']])
  assert.deepEqual(labeled.groups[0]?.money, [false, false, true])
  assert.deepEqual(labeled.groups[0]?.align, ['left', 'left', 'right'])
  assert.deepEqual(data, before)
})
