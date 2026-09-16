import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatWindow } from './rule-window.ts'

const tableSource = readFileSync(fileURLToPath(new URL('./RulesTable.tsx', import.meta.url)), 'utf8')

test('window cells render the range or the open-ended label', () => {
  assert.equal(formatWindow('2026-01-01', '2026-12-31', 'open-ended'), '2026-01-01 – 2026-12-31')
  assert.equal(formatWindow('2027-01-01', null, 'open-ended'), '2027-01-01 – open-ended')
})

test('rules table is a searchable house list opening the rule drawer', () => {
  // PagedTable: searched + paginated like every house list.
  assert.match(tableSource, /<PagedTable<RuleHeadSummary>/)
  assert.match(tableSource, /searchable/)
  // New button and row clicks drive the `?rule=` drawer param the drawer host owns.
  assert.match(tableSource, /rule: ruleParam/)
  assert.match(tableSource, /openRule\(row\.rule\.id\)/)
  assert.match(tableSource, /rules\.list\.new/)
  // Columns: name, key, mode, current-version status, window, order, active.
  for (const column of ['name', 'key', 'mode', 'version', 'window', 'order', 'active']) {
    assert.ok(tableSource.includes(`key: '${column}'`), `${column} column must exist`)
  }
  // Labels come from the catalog — never literals, never dynamic keys.
  assert.match(tableSource, /rules\.modes\.entry/)
  assert.match(tableSource, /rules\.statuses\.published/)
  assert.ok(!/t\(`[^`]*\$\{/.test(tableSource), 'no dynamic i18n keys')
})

test('rules table scrolls horizontally on narrow viewports (seven columns)', () => {
  // PagedTable renders a plain table with no overflow of its own, so the
  // usage owns the narrow-viewport scroll container (tablet floor).
  assert.match(tableSource, /overflow-x-auto/)
})
