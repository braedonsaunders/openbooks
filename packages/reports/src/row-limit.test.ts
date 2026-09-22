import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compileCustomQuery, normalizeReportLimit } from './custom-query'
import { REPORT_ENTITY_MAP } from './entities'
import { validateCustomQuery } from './validate'

const ledger = REPORT_ENTITY_MAP.ledger_lines!

test('full report plans preserve requested sizes above the former 10,000-row ceiling', () => {
  const query = validateCustomQuery({
    entity: ledger.key,
    mode: 'rows',
    columns: ['entry_number'],
    filters: null,
    limit: 75_000,
  })
  assert.equal(query.limit, 75_000)

  const compiled = compileCustomQuery(ledger, query, '00000000-0000-4000-8000-000000000001')
  assert.equal(compiled.limit, 75_000)
  assert.match(compiled.text, /LIMIT 75000$/)
})

test('studio previews remain explicitly bounded without rewriting the saved row limit', () => {
  const query = validateCustomQuery({
    entity: ledger.key,
    mode: 'rows',
    columns: ['entry_number'],
    filters: null,
    limit: 75_000,
  })
  const compiled = compileCustomQuery(ledger, query, 'org', { maxRows: 200 })
  assert.equal(compiled.limit, 200)
  assert.equal(query.limit, 75_000)
})

test('row limits accept only positive safe integers', () => {
  assert.equal(normalizeReportLimit(0), 1)
  assert.equal(normalizeReportLimit(1234.9), 1234)
  assert.equal(normalizeReportLimit(Number.MAX_SAFE_INTEGER + 1), Number.MAX_SAFE_INTEGER)
})
