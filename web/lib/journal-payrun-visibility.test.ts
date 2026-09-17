import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t08-014: a posted payroll JE hit the GL but was invisible in /journal
// (list predicate excluded kind pay_run) and the run's "View journal entry"
// link passed an entry id to ?entry= (a document-id drawer for kind
// journal only), so no drawer opened either. The JE must appear in the
// list and count, and its deep link must open the entry drawer (?txn=,
// served globally by the app-shell drawer host).
const unionSource = readFileSync(
  new URL('./customization/entity-list-query/journal-entries.ts', import.meta.url),
  'utf8',
)
const journalView = readFileSync(
  new URL('../app/(app)/journal/view.ts', import.meta.url),
  'utf8',
)
const entitySources = readFileSync(new URL('./list/entity-sources.ts', import.meta.url), 'utf8')
const runWizard = readFileSync(
  new URL('../app/(app)/payroll/runs/[id]/RunWizard.tsx', import.meta.url),
  'utf8',
)

test('the journal union lists posted pay_run entries', () => {
  assert.match(unionSource, /jd\.kind in \('journal', 'pay_run'\)/)
})

test('the journal count predicate matches the union', () => {
  assert.match(journalView, /journalScopeWhere/)
  assert.match(journalView, /JOURNAL_ENTRY_TABLE/)
})

test('pay_run rows open the entry drawer, not the manual-journal document drawer', () => {
  assert.match(entitySources, /source_document_kind/)
  assert.match(entitySources, /\{ param: 'txn', id: String\(row\.id\) \}/)
})

test('the run links its posted and paid entries to the entry drawer', () => {
  assert.match(runWizard, /\/journal\?txn=\$\{run\.posted_entry_id\}/)
  assert.match(runWizard, /\/journal\?txn=\$\{run\.paid_entry_id\}/)
  assert.doesNotMatch(runWizard, /\/journal\?entry=\$\{run\.posted_entry_id\}/)
  assert.doesNotMatch(runWizard, /\/journal\?entry=\$\{run\.paid_entry_id\}/)
})
