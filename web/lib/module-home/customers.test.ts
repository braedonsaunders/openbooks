import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(import.meta.dirname, 'customers.ts'), 'utf8')

test('customer receipt totals convert every transaction amount before aggregation', () => {
  // The trend and 7-day badge each need the per-document conversion. Summing
  // transaction totals directly would make (for example) CAD 100 + JPY 10,000
  // appear as one 10,100-unit amount in the organization currency.
  const conversions = source.match(/sum\(round\(abs\(d\.total \* d\.fx_rate\), 4\)\)/g) ?? []
  assert.equal(conversions.length, 2)
  assert.doesNotMatch(source, /sum\(abs\(d\.total\)\)/)
})
