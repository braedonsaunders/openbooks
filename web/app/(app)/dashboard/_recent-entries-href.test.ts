import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./_widget-views.tsx', import.meta.url), 'utf8')

/**
 * F-t06-005 — every "Recent journal entries" row must resolve through the
 * posted-entry route (/journal/[id]), which redirects each entry to the
 * drawer that owns it (source-document drawer for subledger postings,
 * journal drawer for manual journals, txn drawer for GL-native entries).
 * The old href built /journal?entry=<ENTRY id>, but ?entry= drives the
 * manual-journal drawer over DOCUMENT ids of kind 'journal' only
 * (loadJournalDoc), so subledger postings opened nothing (dead links) and
 * even manual-journal rows missed (entry id never equals the doc id).
 */
test('recent journal entries link through the posted-entry route, not the manual-journal drawer param', () => {
  assert.match(
    source,
    /href=\{`\/journal\/\$\{/,
    'recent-entry rows must link to /journal/<entry id> so every origin resolves to a drawer',
  )
  assert.doesNotMatch(
    source,
    /journal\?entry=\$\{/,
    '?entry= takes a manual-journal DOCUMENT id — an entry id there never opens a drawer',
  )
})
