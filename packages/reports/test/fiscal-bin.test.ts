import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileCustomQuery } from '../src/custom-query.ts'
import { REPORT_ENTITY_MAP } from '../src/entities.ts'

test('fiscal_year bin uses the fiscal shift for a non-Jan start', () => {
  const entity = REPORT_ENTITY_MAP['ledger_lines']!
  const q = { entity: 'ledger_lines', mode: 'summarize', columns: [],
    breakouts: [{ column: 'posting_date', bin: 'fiscal_year' }], measures: [{ fn: 'sum', column: 'amount' }] }
  const april = compileCustomQuery(entity, q, 'org1', { fiscalStartMonth: 4 })
  assert.match(april.text, /interval '3 months'/, april.text)
  const jan = compileCustomQuery(entity, q, 'org1', { fiscalStartMonth: 1 })
  assert.match(jan.text, /date_trunc\('year'/, jan.text)
  assert.ok(!/interval '0 months'/.test(jan.text))
})

test('fiscal_period bin buckets by calendar month', () => {
  const entity = REPORT_ENTITY_MAP['ledger_lines']!
  const q = { entity: 'ledger_lines', mode: 'summarize', columns: [],
    breakouts: [{ column: 'posting_date', bin: 'fiscal_period' }], measures: [{ fn: 'count' }] }
  const c = compileCustomQuery(entity, q, 'org1', { fiscalStartMonth: 4 })
  assert.match(c.text, /date_trunc\('month'/)
})
