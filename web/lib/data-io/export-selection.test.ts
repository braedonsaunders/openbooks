import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExportColumns } from './export-selection.ts'

const columns = [
  { key: 'number', label: 'Number', kind: 'text' as const },
  { key: 'total', label: 'Total', kind: 'currency' as const },
]

test('only an absent selection means a full export', () => {
  assert.deepEqual(selectExportColumns(columns, undefined), { ok: true, columns })
  assert.deepEqual(selectExportColumns(columns, ['total']), { ok: true, columns: [columns[1]] })
  assert.deepEqual(selectExportColumns(columns, []), {
    ok: false,
    error: 'columns must include at least one known column',
  })
})

test('unknown selected columns are named and never widen to all columns', () => {
  assert.deepEqual(selectExportColumns(columns, ['retired_field']), {
    ok: false,
    error: 'unknown export columns: retired_field',
  })
  assert.deepEqual(selectExportColumns(columns, ['number', 'retired_field']), {
    ok: false,
    error: 'unknown export columns: retired_field',
  })
})
