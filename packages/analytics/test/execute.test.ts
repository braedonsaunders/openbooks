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
  assert.equal(result.truncated, false)
  assert.equal(released, true)
})

test('runInsightQuery reports truncation when the inner query reaches its cap', async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = []
  const client: PoolClient = {
    async query(text, params) {
      calls.push({ text, params })
      if (!text.startsWith('select * from')) return { rows: [], fields: [] }

      // Model PostgreSQL applying the inner LIMIT before the wrapper LIMIT.
      const innerLimit = Number(text.match(/\nlimit (\d+)\) __insight/)?.[1])
      return {
        rows: Array.from({ length: innerLimit }, (_, index) => ({ id: index + 1 })),
        fields: [{ name: 'id' }],
      }
    },
    release() {},
  }
  const pool: QueryPool = { connect: async () => client }

  const result = await runInsightQuery(
    pool,
    { source: 'ledger_lines', limit: 1 },
    'org-1',
  )

  const execution = calls.find(({ text }) => text.startsWith('select * from'))
  assert.ok(execution)
  assert.match(execution.text, /\nlimit 2\) __insight limit 2$/)
  assert.deepEqual(result.rows, [{ id: 1 }])
  assert.equal(result.rowCount, 1)
  assert.equal(result.truncated, true)
})
