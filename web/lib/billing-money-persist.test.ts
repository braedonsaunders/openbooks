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
