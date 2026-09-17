import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t04-004: previewing a merge in the losing direction 422d
// ("cannot move lines of N non-draft document(s)") and the view only
// toasted — the previous direction's "Merge (0 references)" success stayed
// on screen as if it were the answer, keyed by duplicate id alone so it
// could even leak across groups. A refused preview must clear the cached
// preview for that pair, pin the typed reason as a per-group alert until
// the next action, and a cached preview must only render for the survivor
// direction it was computed for.
const source = readFileSync(new URL('./ProjectDuplicatesView.tsx', import.meta.url), 'utf8')

test('a refused preview clears the cached pair and pins the reason (F-t04-004)', () => {
  const failure = source.slice(
    source.indexOf('async function preview('),
    source.indexOf('async function preview(') + 1400,
  )
  assert.match(
    failure,
    /setPreviews\(\(current\) => withoutPreview\(current, key\)\)/,
    'the preview failure branch must drop the stale cached preview for the pair',
  )
  assert.match(
    failure,
    /setPreviewErrors\(\(current\) => \(\{[^\}]*\[groupKey\]: message/,
    'the preview failure branch must pin the typed reason per group',
  )
})

test('cached previews only render for their survivor direction and group (F-t04-004)', () => {
  assert.match(
    source,
    /previews\[`\$\{groupKey\}:?\$\{project\.id\}`\]/,
    'preview lookup must be keyed by group and duplicate row',
  )
  assert.match(
    source,
    /cached && cached\.survivorId === survivorId \? cached : null/,
    'a cached preview must only render for the survivor it was computed for',
  )
})

test('the duplicates view renders a per-group alert region (F-t04-004)', () => {
  assert.match(
    source,
    /role="alert"/,
    'the view must render a role=alert region for pinned preview/merge refusals',
  )
})
