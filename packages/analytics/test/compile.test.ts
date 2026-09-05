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

test('Insights applies the report catalog subsidiary policy to every source', async () => {
  const { REPORT_ENTITIES } = await import('@openbooks/reports')
  for (const entity of REPORT_ENTITIES) {
    const scope = ['11111111-1111-4111-8111-111111111111']
    const compiled = compileInsightQuery({ source: entity.key }, 'org-1', {}, '2026-09-04', scope)
    const empty = compileInsightQuery({ source: entity.key }, 'org-1', {}, '2026-09-04', [])
    assert.match(empty.sql, / and FALSE/, entity.key)
    if (entity.subsidiaryScope) {
      assert.ok(compiled.sql.includes(`${entity.subsidiaryScope.column} = ANY($2::uuid[])`), entity.key)
      assert.deepEqual(compiled.params[1], scope)
      if (entity.subsidiaryScope.sharedNull) {
        assert.ok(compiled.sql.includes(`(${entity.subsidiaryScope.column} IS NULL OR `), entity.key)
      }
    } else {
      assert.equal(entity.subsidiaryScope, null, 'shared sources must explicitly declare that policy')
    }
  }
})

test('Insights source discovery enforces permissions and authoritative feature gates together', async () => {
  const { allowedSources } = await import('../src/catalog.ts')
  const sources = allowedSources((permission) => permission !== 'payroll.read', (feature) => !['projects', 'timeTracking'].includes(feature))
  assert.ok(sources.some((source) => source.key === 'documents'))
  assert.ok(!sources.some((source) => ['projects', 'timesheets', 'pay_stubs'].includes(source.key)))
})
