import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('CRM estimate persists projected_amount through canonicalDecimal then normalizeMoney', () => {
  const estimate = source('app/api/crm/opportunities/[id]/estimate/route.ts')
  const helperStart = estimate.indexOf('function persistEstimateProjectedAmount')
  const helperEnd = estimate.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistEstimateProjectedAmount helper is defined')
  const helper = estimate.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)
  assert.match(helper, /projected amount must be an exact decimal/)

  const start = estimate.indexOf('export async function POST')
  const persist = estimate.slice(start, estimate.indexOf('insert into documents', start) + 400)
  assert.match(persist, /persistEstimateProjectedAmount\(op\.projected_amount \?\? '0'\)/)
  assert.doesNotMatch(persist, /normalizeMoney\(op\.projected_amount/)
})

test('CRM estimate persists document_lines amount through canonicalDecimal then normalizeMoney', () => {
  const estimate = source('app/api/crm/opportunities/[id]/estimate/route.ts')
  const helperStart = estimate.indexOf('function persistEstimateLineAmount')
  const helperEnd = estimate.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistEstimateLineAmount helper is defined')
  const helper = estimate.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)
  assert.match(helper, /line amount must be an exact decimal/)

  const start = estimate.indexOf('insert into document_lines')
  const persist = estimate.slice(start, estimate.indexOf('from items i', start))
  assert.match(persist, /persistEstimateLineAmount\(line\.amount\)/)
  assert.doesNotMatch(persist, /normalizeMoney\(line\.amount/)
})

test('CRM estimate persists document_lines quantity through canonicalDecimal then normalizeMoney', () => {
  const estimate = source('app/api/crm/opportunities/[id]/estimate/route.ts')
  const helperStart = estimate.indexOf('function persistEstimateLineQuantity')
  const helperEnd = estimate.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistEstimateLineQuantity helper is defined')
  const helper = estimate.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)
  assert.match(helper, /line quantity must be an exact decimal/)

  const start = estimate.indexOf('insert into document_lines')
  const persist = estimate.slice(start, estimate.indexOf('from items i', start))
  assert.match(persist, /persistEstimateLineQuantity\(line\.quantity\)/)
  assert.doesNotMatch(persist, /normalizeMoney\(line\.quantity/)
})

test('CRM estimate persists document_lines unit_price through canonicalDecimal then normalizeMoney', () => {
  const estimate = source('app/api/crm/opportunities/[id]/estimate/route.ts')
  const helperStart = estimate.indexOf('function persistEstimateLineUnitPrice')
  const helperEnd = estimate.indexOf('\n}', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'persistEstimateLineUnitPrice helper is defined')
  const helper = estimate.slice(helperStart, helperEnd + 2)
  assert.match(helper, /canonicalDecimal\(value, 4\)/)
  assert.match(helper, /normalizeMoney\(exact\)/)
  assert.match(helper, /line unit price must be an exact decimal/)

  const start = estimate.indexOf('insert into document_lines')
  const persist = estimate.slice(start, estimate.indexOf('from items i', start))
  assert.match(persist, /persistEstimateLineUnitPrice\(line\.unit_price\)/)
  assert.doesNotMatch(persist, /normalizeMoney\(line\.unit_price/)
})
