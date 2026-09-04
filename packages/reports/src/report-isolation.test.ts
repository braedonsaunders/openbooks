import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'
import { runCustomQuery } from './run'

test('every report entity declares its subsidiary policy', () => {
  for (const entity of REPORT_ENTITIES) assert.notEqual(entity.subsidiaryScope, undefined, entity.key)
})

test('server scope is independent of user OR filters and applies to count queries', () => {
  const entity = REPORT_ENTITY_MAP.documents!
  const q = { entity: 'documents', columns: ['document_number'], filters: { combinator: 'or', rules: [
    { field: 'document_number', op: 'eq', value: 'secret' },
  ] } }
  const compiled = compileCustomQuery(entity, q, 'org', { allowedSubsidiaryIds: ['allowed'] })
  assert.match(compiled.text, /d\.subsidiary_id = ANY\(\$2::uuid\[\]\)/)
  assert.deepEqual(compiled.values.slice(0, 2), ['org', ['allowed']])
  assert.match(compileCustomQuery(entity, q, 'org', { allowedSubsidiaryIds: [] }).text, /FALSE/)
})

test('overlapping distinct populations never produce additive totals', async () => {
  const result = await runCustomQuery({ query: async () => ({ rows: [
    { d0: 'January', m0: '1' }, { d0: 'February', m0: '1' },
  ] }) }, { entity: 'documents', mode: 'summarize', breakouts: [{ column: 'document_number' }],
    measures: [{ fn: 'count_distinct', column: 'party_id' }] }, { orgId: 'org', entityMap: REPORT_ENTITY_MAP })
  assert.equal(result.groups[0]!.rows.length, 2)
  assert.equal(result.summary.length, 1, 'distinct count must not create a misleading total card')
})
