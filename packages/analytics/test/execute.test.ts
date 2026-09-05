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
    null,
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
    null,
  )

  const execution = calls.find(({ text }) => text.startsWith('select * from'))
  assert.ok(execution)
  assert.match(execution.text, /\nlimit 2\) __insight limit 2$/)
  assert.deepEqual(result.rows, [{ id: 1 }])
  assert.equal(result.rowCount, 1)
  assert.equal(result.truncated, true)
})

test('Insights requires scope before connecting and releases the read transaction on failure', async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = []
  let connected = false
  let released = false
  const pool: QueryPool = { connect: async () => {
    connected = true
    return {
      async query(text, params) {
        calls.push({ text, params })
        if (text.startsWith('select * from')) throw new Error('query interrupted')
        return { rows: [], fields: [] }
      },
      release() { released = true },
    }
  } }
  // A JavaScript caller must not silently become unrestricted by omitting scope.
  await assert.rejects(() => runInsightQuery(pool, { source: 'documents' }, 'org-1', undefined as unknown as null), /explicit subsidiary/)
  assert.equal(connected, false)
  await assert.rejects(() => runInsightQuery(pool, { source: 'documents' }, 'org-1', ['sub-1']), /query interrupted/)
  assert.equal(calls[0]?.text, 'begin transaction read only')
  assert.match(calls[1]!.text, /set_config\('app.current_org', \$1, true\).*set_config\('app.bypass_rls', 'off', true\)/)
  assert.deepEqual(calls[1]!.params, ['org-1'])
  const execution = calls.find(({ text }) => text.startsWith('select * from'))!
  assert.match(execution.text, /d\.subsidiary_id = ANY\(\$2::uuid\[\]\)/)
  assert.deepEqual(execution.params, ['org-1', ['sub-1']])
  assert.equal(calls.at(-1)?.text, 'rollback')
  assert.equal(released, true)
})
