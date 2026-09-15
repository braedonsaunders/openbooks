import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ProjectProfitabilityTable.tsx', import.meta.url), 'utf8')

test('project profitability passes decimalRatio margins directly to Intl percent formatting', () => {
  assert.match(
    source,
    /format\.number\(Number\(value\)\s*,\s*\{\s*style:\s*'percent'/,
    'decimalRatio returns 0.2500 for a 25% margin and Intl percent formatting expects 0.25',
  )
})

test('project profitability keeps decimalRatio values in ratio units', () => {
  assert.doesNotMatch(
    source,
    /Number\(value\)\s*\/\s*10000/,
    'decimalRatio returns 0.2500 for a 25% margin; dividing it again would display 0.0%',
  )
})
