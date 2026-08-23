import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('invoice generation persists time hours and rates through canonicalDecimal then normalizeMoney', () => {
  const billing = source('lib/billing.ts')
  const helperStart = billing.indexOf('function persistInvoiceDecimal')
  const helperEnd = billing.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistInvoiceDecimal helper is defined')
  const helper = billing.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)

  const timeLoopStart = billing.indexOf('for (const te of timeRows.rows)')
  const timeLoopEnd = billing.indexOf('Cost is billed for the SAME period', timeLoopStart)
  assert.ok(timeLoopStart >= 0 && timeLoopEnd > timeLoopStart, 'time-entry invoice loop is present')
  const timeLoop = billing.slice(timeLoopStart, timeLoopEnd)
  assert.match(timeLoop, /persistInvoiceDecimal\(te\.hours \?\? '0'/)
  assert.match(timeLoop, /persistInvoiceDecimal\(te\.cost_rate \?\? '0'/)
  assert.match(timeLoop, /persistInvoiceDecimal\(te\.bill_rate \?\? te\.default_rate \?\? '0'/)
  assert.match(timeLoop, /quantity: hours/)
  assert.doesNotMatch(timeLoop, /String\(te\.hours/)
  assert.doesNotMatch(timeLoop, /String\(te\.cost_rate/)
  assert.doesNotMatch(timeLoop, /String\(te\.bill_rate/)
  assert.doesNotMatch(timeLoop, /String\(te\.default_rate/)
})

test('invoice generation persists cost-line qty, rate, and amount through exact-decimal helpers', () => {
  const billing = source('lib/billing.ts')
  const helperStart = billing.indexOf('function persistInvoiceQuantity')
  const helperEnd = billing.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistInvoiceQuantity helper is defined')
  const helper = billing.slice(helperStart, helperEnd + 2)
  // document_lines.quantity is numeric(28,8): Postgres hands every stored
  // line back at eight decimals, so quantities canonicalize at that scale.
  assert.match(helper, /canonicalDecimal\(value, 8\)/)

  const costLoopStart = billing.indexOf('for (const cl of costRows.rows)')
  const costLoopEnd = billing.indexOf('Lump-sum markup', costLoopStart)
  assert.ok(costLoopStart >= 0 && costLoopEnd > costLoopStart, 'cost-line invoice loop is present')
  const costLoop = billing.slice(costLoopStart, costLoopEnd)
  assert.match(costLoop, /persistInvoiceDecimal\(cl\.amount \?\? '0'/)
  assert.match(costLoop, /persistInvoiceDecimal\(cl\.bill_amount \?\? '0'/)
  assert.match(costLoop, /persistInvoiceQuantity\(cl\.quantity \?\? '1'/)
  assert.match(costLoop, /persistInvoiceDecimal\(cl\.bill_rate \?\? amount/)
  assert.match(costLoop, /persistInvoiceQuantity\(component\.quantity \?\? '0'/)
  assert.match(costLoop, /persistInvoiceDecimal\(component\.rate \?\? '0'/)
  assert.match(costLoop, /persistInvoiceDecimal\(component\.amount \?\? '0'/)
  assert.doesNotMatch(costLoop, /String\(cl\.amount/)
  assert.doesNotMatch(costLoop, /String\(cl\.bill_amount/)
  assert.doesNotMatch(costLoop, /String\(cl\.quantity/)
  assert.doesNotMatch(costLoop, /String\(cl\.bill_rate/)
  assert.doesNotMatch(costLoop, /String\(component\.quantity/)
  assert.doesNotMatch(costLoop, /String\(component\.rate/)
  assert.doesNotMatch(costLoop, /String\(component\.amount/)
})
