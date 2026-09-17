import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t08-002 (partial): the rate dialog's region picker rendered the pack's
// raw region token ("state") as its label. The run view already presents the
// pack's declared label capitalized ("State"/"Province"); the dialog must do
// the same instead of showing the raw token.
const source = readFileSync(new URL('./StatutoryRatesSection.tsx', import.meta.url), 'utf8')

test('the rate dialog labels the region picker from the pack, capitalized', () => {
  assert.doesNotMatch(source, /\{pack\?\.regionLabel \?\? label\('rates\.columns\.region'/)
})

// F-t08-007: a rejected Save (422) left the dialog open with no visible
// message — the toast alone reads as "still saving". The rejection stays
// rendered inside the drawer until the next save.
test('the rate dialog keeps the save rejection visible inside the drawer', () => {
  assert.match(source, /setSaveError\(message\)/)
  assert.match(source, /<Alert variant="destructive">\{saveError\}<\/Alert>/)
})

// F-t08-008: the Effective-rate box gave no hint it wants a decimal, and the
// table rendered the raw decimal. Rate/percent inputs name their scale and
// accepted range from the pack declaration; the table renders percents.
test('rate inputs name their scale and range from the declaration', () => {
  assert.match(source, /rates\.rateScaleHint/)
  assert.match(source, /\{field\.min\}–\{field\.max\}/)
})

test('the rates table renders decimal rates as percents', () => {
  assert.match(source, /formatRateFieldValue\(field, /)
})
