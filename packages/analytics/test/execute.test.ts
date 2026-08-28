import assert from 'node:assert/strict'
import test from 'node:test'
import { runInsightQuery, type PoolClient, type QueryPool } from '../src/execute.ts'

test('runInsightQuery compiles and executes the migrated query', async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = []
  let released = false
  const client: PoolClient = {
    async query(text, params) {
      calls.push({ text, params })
      return { rows: text.startsWith('select * from') ? [{ party_name: 'Acme', count: 1 }] : [], fields: [] }
    },
    release() {
      released = true
    },
  }
  const pool: QueryPool = { connect: async () => client }

  const result = await runInsightQuery(
    pool,
    {
      source: 'ledger_lines',
      dimensions: [{ field: 'party' }],
      measures: [{ agg: 'count' }],
    },
    'org-1',
  )

  const execution = calls.find(({ text }) => text.startsWith('select * from'))
  assert.ok(execution)
  assert.match(execution.text, /p\.display_name as "party_name"/)
  assert.deepEqual(execution.params, ['org-1'])
  assert.equal(result.columns[0]?.key, 'party_name')
  assert.equal(result.rowCount, 1)
  assert.equal(released, true)
})
