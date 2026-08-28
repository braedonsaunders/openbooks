import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('fair-value editor preserves exact monetary decimal strings', () => {
  const editor = source('app/(app)/items/FairValuePricesEditor.tsx')
  const helperStart = editor.indexOf('const num =')
  const helperEnd = editor.indexOf('\n', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'fair-value decimal helper is defined')

  const helper = editor.slice(helperStart, helperEnd)
  assert.match(helper, /v != null \? String\(v\) : ''/)
  assert.doesNotMatch(helper, /Number\(v\)/)
  assert.match(editor, /unitPrice: num\(p\.unit_price\)/)
  assert.match(editor, /lowValue: num\(p\.low_value\)/)
  assert.match(editor, /highValue: num\(p\.high_value\)/)

  const beyondSafeInteger = '9007199254740993.0000'
  assert.equal(String(beyondSafeInteger), beyondSafeInteger)
  assert.notEqual(String(Number(beyondSafeInteger)), beyondSafeInteger)
})
