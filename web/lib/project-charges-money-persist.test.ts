import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('project charges persist cost/bill qty-rate-amount through canonicalDecimal then normalizeMoney', () => {
  const charges = source('lib/project-charges.ts')
  const helperStart = charges.indexOf('function exactMoney')
  const helperEnd = charges.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'exactMoney helper is defined')
  const helper = charges.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)

  const persistStart = charges.indexOf('const resolved = rateSnapshot')
  const persistEnd = charges.indexOf('const accountId = line.accountId')
  assert.ok(persistStart >= 0 && persistEnd > persistStart, 'project-charge rate persist block is present')
  const persist = charges.slice(persistStart, persistEnd)
  assert.match(persist, /exactMoney\(enteredCostRate \?\? it\.default_cost \?\? '0'/)
  assert.match(persist, /exactMoney\(enteredBillRate \?\? it\.default_rate \?\? fallbackCostRate/)
  assert.match(persist, /exactMoney\(resolved\?\.cost\.amount \?\? mul\(quantity, fallbackCostRate\)/)
  assert.match(persist, /exactMoney\(resolved\?\.bill\.amount \?\? mul\(quantity, fallbackBillRate\)/)
  assert.match(persist, /const costRate = exactMoney\(/)
  assert.match(persist, /const billRate = exactMoney\(/)
  assert.doesNotMatch(persist, /String\(enteredCostRate/)
  assert.doesNotMatch(persist, /String\(enteredBillRate/)
  assert.doesNotMatch(persist, /String\(it\.default_cost/)
  assert.doesNotMatch(persist, /String\(it\.default_rate/)
  assert.doesNotMatch(persist, /normalizeMoney\(canDerive/)
})
