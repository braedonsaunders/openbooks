import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../app/(app)/admin/setup/[entity]/RateBookDrawer.tsx', import.meta.url),
  'utf8',
)

test('rate-book item rates use the shared paginated table with the add action above it', () => {
  assert.match(source, /subtabs=\{/)
  assert.match(source, /role="tab"/)
  assert.match(source, /activeTab === 'overview'/)
  assert.match(source, /activeTab === 'rates'/)
  assert.match(source, /<PagedTable<EditableRateBookLine>/)
  assert.match(source, /pageSize=\{10\}/)
  assert.match(source, /searchable/)
  assert.match(source, /emptyAsRow/)
  assert.doesNotMatch(source, /<LineGrid(?:\s|>)/)

  const addAction = source.indexOf("t('addItem')")
  const table = source.indexOf('<PagedTable<EditableRateBookLine>')
  assert.ok(addAction >= 0 && addAction < table, 'Add item rate must render above the table')
})
