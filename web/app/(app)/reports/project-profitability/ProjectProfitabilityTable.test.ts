import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ProjectProfitabilityTable.tsx', import.meta.url), 'utf8')

test('project profitability converts exact percentage-point margins for Intl percent formatting', () => {
  assert.match(
    source,
    /format\.number\(Number\(value\)\s*\/\s*10000\s*,\s*\{\s*style:\s*'percent'/,
    'a 25% margin is stored as 2500.0000 and must reach Intl as 0.25',
  )
})
