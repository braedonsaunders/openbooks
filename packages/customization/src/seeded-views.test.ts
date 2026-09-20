import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SEEDED_DEFAULT_MARK,
  configMatchesSeedShape,
  isUntouchedSeededView,
  markSeededDefaultView,
  stripSeededDefaultMark,
  defaultListView,
} from './index.ts'
import { RECORD_TYPES, getRecordType } from './registry.ts'

const employee = getRecordType('employee')!
const staleDescSeed = {
  ...defaultListView('employee'),
  // The frozen pre-registry snapshot: A→Z had not been declared yet.
  sort: { column: 'display_name', dir: 'desc' as const },
}
const row = (overrides: Record<string, unknown>) => ({
  scope: 'org',
  config: staleDescSeed,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  ...overrides,
})

// The stored SORT is deliberately not compared: the frozen seed's stale
// direction IS the defect, and a sort-only edit through the designer is
// already caught by the metadata rule.
test('an untouched old seed follows the registry despite its stale sort', () => {
  assert.equal(isUntouchedSeededView(row({}), employee), true)
  assert.deepEqual(defaultListView('employee').sort, { column: 'display_name', dir: 'asc' })
})

// A marked seed is untouched even when its timestamps differ: the mark alone
// carries the metadata rule, so no heuristic is needed going forward.
test('an untouched new seed with a mark follows the registry', () => {
  assert.equal(
    isUntouchedSeededView(
      row({
        config: markSeededDefaultView(staleDescSeed),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      }),
      employee,
    ),
    true,
  )
})

// A sort-only edit through the designer bumps updated_at (and strips the
// mark on parse): the metadata rule fails, so the stored sort is kept.
test('a row edited only in sort keeps its sort', () => {
  const edited = row({
    config: { ...staleDescSeed, sort: { column: 'short_code', dir: 'desc' as const } },
    updatedAt: new Date('2025-02-01T00:00:00Z'),
  })
  assert.equal(isUntouchedSeededView(edited, employee), false)
})

// A customised column fails the shape rule on its own — even with equal
// timestamps, so no timestamp story can resurrect discarded edits.
test('a row with a customised column keeps everything', () => {
  const at = new Date('2025-01-01T00:00:00Z')
  for (const columns of [
    staleDescSeed.columns.map((c) => (c.key === 'display_name' ? { ...c, labelOverride: 'Staff' } : c)),
    staleDescSeed.columns.map((c) => (c.key === 'display_name' ? { ...c, width: 999 } : c)),
    staleDescSeed.columns.map((c) => (c.key === 'email' ? { ...c, visible: false } : c)),
  ]) {
    assert.equal(
      isUntouchedSeededView(row({ config: { ...staleDescSeed, columns }, createdAt: at, updatedAt: at }), employee),
      false,
    )
  }
  assert.equal(
    isUntouchedSeededView(
      row({ config: { ...staleDescSeed, filters: [{ key: 'status', operator: 'eq', value: 'x', to: null }] } }),
      employee,
    ),
    false,
  )
  assert.equal(isUntouchedSeededView(row({ config: { ...staleDescSeed, perPage: 50 } }), employee), false)
})

// Extra or missing columns are registry drift (custom fields, retired
// built-ins), not an edit: the shape rule compares only surviving columns.
test('registry drift in the column set is not an edit', () => {
  const withExtra = {
    ...staleDescSeed,
    columns: [...staleDescSeed.columns, { key: 'cf_favourite_colour', visible: true, width: null, labelOverride: null }],
  }
  assert.equal(configMatchesSeedShape(withExtra, employee), true)
  assert.equal(isUntouchedSeededView(row({ config: withExtra }), employee), true)
  const missingOne = { ...staleDescSeed, columns: staleDescSeed.columns.slice(1) }
  assert.equal(configMatchesSeedShape(missingOne, employee), true)
  assert.equal(isUntouchedSeededView(row({ config: missingOne }), employee), true)
})

// A designer save strips the mark (parseListView drops unknown keys), so a
// re-saved row is never mistaken for untouched: the later updated_at decides.
test('a re-saved marked row loses its untouched status via timestamps', () => {
  const saved = stripSeededDefaultMark(markSeededDefaultView(staleDescSeed))
  assert.equal((saved as unknown as Record<string, unknown>)[SEEDED_DEFAULT_MARK], undefined)
  assert.equal(
    isUntouchedSeededView(
      row({ config: saved, updatedAt: new Date('2025-02-01T00:00:00Z') }),
      employee,
    ),
    false,
  )
})

// User-scoped views are personal, never system defaults — even marked rows
// with equal timestamps stay out of the org-default rule.
test('user-scoped views are never treated as untouched system defaults', () => {
  assert.equal(isUntouchedSeededView(row({ scope: 'user' }), employee), false)
  assert.equal(
    isUntouchedSeededView(row({ scope: 'user', config: markSeededDefaultView(staleDescSeed) }), employee),
    false,
  )
})

// Missing timestamps, a missing config, or no registry meta fail closed to
// "edited": without both halves of the evidence, the stored config wins.
test('missing evidence fails closed to edited', () => {
  assert.equal(isUntouchedSeededView(row({ createdAt: null, updatedAt: null }), employee), false)
  assert.equal(isUntouchedSeededView(row({ config: null }), employee), false)
  assert.equal(isUntouchedSeededView(row({}), null), false)
})

// Registry audit (HR-1 defect 1): directories open ascending, dated lists
// newest-first. bank_rule opens in evaluation (priority) order, not
// newest-first; project opens A→Z like every other name directory.
test('rule and project lists open in evaluation and name order', () => {
  assert.deepEqual(defaultListView('bank_rule').sort, { column: 'priority', dir: 'asc' })
  assert.deepEqual(defaultListView('project').sort, { column: 'name', dir: 'asc' })
})

// Every record type whose registry declares a defaultSort opens on it: the
// stored snapshot's direction must never override the live declaration.
test('the direction of every registry-declared defaultSort is honoured', () => {
  const declared = RECORD_TYPES.filter((meta) => meta.defaultSort)
  assert.ok(declared.length >= 6, `expected declared defaults, saw ${declared.length}`)
  for (const meta of declared) {
    const view = defaultListView(meta.key)
    const column = meta.listColumns.find((c) => c.sortable && c.sortKey === meta.defaultSort!.sortKey)
    assert.ok(column, `${meta.key}: declared sortKey ${meta.defaultSort!.sortKey} must be a sortable column`)
    assert.deepEqual(
      view.sort,
      { column: column!.key, dir: meta.defaultSort!.dir },
      `${meta.key}: live default must open on the declared sort`,
    )
  }
})
