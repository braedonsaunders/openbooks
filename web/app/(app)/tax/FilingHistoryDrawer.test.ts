import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FilingHistoryDrawer.tsx', import.meta.url), 'utf8')

test('tax filing history preserves exact box decimals', () => {
  assert.match(source, /import \{ formatDecimal \} from ['"]\.\.\/\.\.\/\.\.\/lib\/money-format['"]/) 
  assert.match(source, /formatDecimal\(locale, box\.value,/) 
  assert.doesNotMatch(source, /Number\(box\.value\)\.toLocaleString/)
})

test('typed mark-filed refusals surface their remedy, never a generic failure (F-x5-001)', () => {
  // The period-not-closed 409 arrived UI-silent: markFiled threw a bare
  // Error and the drawer toasted a generic save failure. The drawer must
  // parse the refusal body and map each typed code to localized copy.
  assert.match(source, /response\.json\(\)/, 'the drawer must read the refusal body')
  assert.match(source, /code === 'period-not-closed'/, 'period-not-closed must map through its code')
  assert.match(source, /code === 'already-filed'/, 'already-filed must map through its code')
  assert.match(source, /code === 'stale'/, 'stale must map through its code')
  assert.match(source, /t\('errors\.periodNotClosed'\)/, 'period-not-closed must resolve to localized copy')
})

test('a refused mark-filed persists inline, not just in a toast (F-x5-001)', () => {
  // A toast alone is missable and vanishes; the refusal names a remedy the
  // operator must still see beside the button.
  assert.match(source, /setMarkError\(message\)/, 'the refusal must persist in drawer state')
  assert.match(source, /role="alert"/, 'the persisted refusal must be an alert')
})
