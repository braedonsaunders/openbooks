import assert from 'node:assert/strict'
import test from 'node:test'
import { compileInsightQuery } from '../src/compile.ts'

test('compileInsightQuery emits valid SQL for not_in filters', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      filters: [{ field: 'party_name', op: 'not_in', value: ['Excluded'] }],
    },
    'org-1',
  )

  assert.match(compiled.sql, /p\.display_name <> all\(\$2\)/)
  assert.doesNotMatch(compiled.sql, /not\s*=\s*any/i)
  assert.deepEqual(compiled.params, ['org-1', ['Excluded']])
})

test('compileInsightQuery keeps an empty not_in filter as a no-op', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      filters: [{ field: 'party_name', op: 'not_in', value: [] }],
    },
    'org-1',
  )

  assert.match(compiled.sql, /where jl\.org_id = \$1 and true/)
  assert.deepEqual(compiled.params, ['org-1'])
})
