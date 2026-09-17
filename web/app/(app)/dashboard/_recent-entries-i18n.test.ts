import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./_widget-views.tsx', import.meta.url), 'utf8')

// F-t01-009: every recent-entry row showed the English "posted" badge and
// "N lines" count under fr/es while the whole surrounding dashboard was
// translated. The status and the line count must come from the catalog.
test('recent journal rows render the status and line count from the catalog', () => {
  assert.doesNotMatch(
    source,
    /\{e\.status\}/,
    'the raw status code must never render — it reads English in every locale',
  )
  assert.doesNotMatch(
    source,
    /\{e\.lineCount\} lines/,
    'the English "N lines" count must come from the catalog',
  )
  assert.match(
    source,
    /recentEntryStatusPosted/,
    'the posted badge must resolve through dashboard.widgets copy',
  )
  assert.match(
    source,
    /recentEntryStatusReversed/,
    'the reversed badge must resolve through dashboard.widgets copy',
  )
  assert.match(
    source,
    /recentEntryLines/,
    'the line count must resolve through a dashboard.widgets plural',
  )
})
