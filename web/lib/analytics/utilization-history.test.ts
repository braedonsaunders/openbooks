import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
const dialect = new PgDialect()
const statements: { sql: string; params: unknown[] }[] = []
let refuse = false
Object.assign(globalThis, { __utilizationHistoryRead: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const statement = dialect.sqlToQuery(query); statements.push(statement)
  if (refuse) throw new Error('Time history source is unavailable.')
  if (/\band false\b/i.test(statement.sql)) return { rows: [] }
  return { rows: [
    { window_index: 1, department: 'services', total_hours: '12.5000', billable_hours: '8.2500' },
    { window_index: 0, department: null, total_hours: '3.0000', billable_hours: '1.5000' },
    { window_index: 0, department: 'services', total_hours: '10.0000', billable_hours: '7.0000' },
  ] }
} })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@openbooks/engine/platform/database' || specifier === '@openbooks/engine/src/platform/db.ts') return { shortCircuit: true, url: 'data:text/javascript,export function ambientTenantOrgId(){return null} export async function withBypassContext(read){return read()} export const db={execute(query){return globalThis.__utilizationHistoryRead(query)}}' }
  return next(specifier, context)
} })
const { fetchHistoryHours } = await import('./utilization-history')
const plans = [{ start: '2026-01-01', end: '2026-01-31' }, { start: '2025-12-01', end: '2025-12-31' }, { start: '2025-11-01', end: '2025-11-30' }]
const orgId = '00000000-0000-4000-8000-000000000001'
const entityId = '00000000-0000-4000-8000-000000000002'

test('history uses one approved-time read, binds tenant and legal entity, and transfers only department hours', async () => {
  statements.length = 0
  const rows = await fetchHistoryHours(orgId, plans, new Set([entityId]))
  assert.equal(statements.length, 1)
  const statement = statements[0]!
  assert.match(statement.sql, /join \(values/i)
  assert.match(statement.sql, /t\.status = 'approved'/)
  assert.match(statement.sql, /coalesce\(project\.subsidiary_id, p\.subsidiary_id\)/)
  assert.match(statement.sql, /group by periods\.window_index, t\.department_id/i)
  assert.doesNotMatch(statement.sql, /cost_rate|fx_rates|employee_name|item_name/)
  assert.ok(statement.params.includes(orgId))
  assert.ok(statement.params.some((value) => value === `{${entityId}}`))
  for (const plan of plans) assert.ok(statement.params.includes(plan.start) && statement.params.includes(plan.end))
  assert.equal(rows[0]!.length, 2)
  assert.equal(rows[1]![0]!.total_hours, '12.5000')
  assert.deepEqual(rows[2], [])
})

test('an empty legal-entity grant cannot read time history; an empty plan does not query', async () => {
  statements.length = 0
  assert.deepEqual(await fetchHistoryHours(orgId, [], null), [])
  assert.equal(statements.length, 0)
  assert.deepEqual(await fetchHistoryHours(orgId, plans, new Set()), [[], [], []])
  assert.match(statements[0]!.sql, /\band false\b/i)
})

test('history source failures are raised instead of becoming a zero utilization chart', async (t) => {
  refuse = true
  t.after(() => { refuse = false })
  await assert.rejects(() => fetchHistoryHours(orgId, plans, null), /Time history source is unavailable/)
})
