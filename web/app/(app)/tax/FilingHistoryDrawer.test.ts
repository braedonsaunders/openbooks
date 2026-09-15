import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FilingHistoryDrawer.tsx', import.meta.url), 'utf8')

test('tax filing history preserves exact box decimals', () => {
  assert.match(source, /import \{ formatDecimal \} from ['"]\.\.\/\.\.\/\.\.\/lib\/money-format['"]/) 
  assert.match(source, /formatDecimal\(locale, box\.value,/) 
  assert.doesNotMatch(source, /Number\(box\.value\)\.toLocaleString/)
})
