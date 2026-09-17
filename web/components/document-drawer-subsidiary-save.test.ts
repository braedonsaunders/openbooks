import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t03-003: the subsidiary SearchSelect labeled its EMPTY option with the
// root subsidiary's name (emptyLabel/placeholder = rootName), so the picker
// listed "Main Co" twice and the pre-selected first entry saved as null —
// which F-t03-002 then tripped over at save. An unset subsidiary must read
// as unset, never as Main Co.
const source = readFileSync(new URL('./document-drawer.tsx', import.meta.url), 'utf8')

test('the subsidiary picker never labels its empty option as the root subsidiary (F-t03-003)', () => {
  assert.doesNotMatch(
    source,
    /emptyLabel=\{rootName\}/,
    'the clearable empty option must not masquerade as the root subsidiary',
  )
  assert.doesNotMatch(
    source,
    /placeholder=\{rootName\}/,
    'an empty subsidiary field must not display the root name as a placeholder',
  )
})

test('an unset subsidiary reads as unset in view mode, not as the root (F-t03-003)', () => {
  assert.doesNotMatch(
    source,
    /\{subsidiaryId \? subsidiaryName\(subsidiaryId\) : rootName\}/,
    'view mode must not present a null subsidiary as the root subsidiary',
  )
})

// F-t03-002: the bill save 422 ("requires a subsidiary") never showed —
// save() toasted and moved on. A save refusal must pin as a record-level
// alert like submit/post refusals already do.
test('a save refusal pins as an alert, not only a toast (F-t03-002)', () => {
  assert.match(
    source,
    /const failure = await readDocumentSaveFailure\(res, t\('toasts\.actionFailed'\)\)\s+[\s\S]*?setActionError\(failure\.message\)/,
    'the save failure branch must pin the typed reason as an alert',
  )
})
