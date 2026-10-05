import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SqlExecutor } from '../platform/db.ts'

const state = globalThis as typeof globalThis & {
  __calendarAllowed: Set<string> | null
  __calendarGates: string[]
  __calendarRefusal: Error | null
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/hrm/attendance.ts')) {
      if (specifier === '../organization/actor-subsidiaries.ts')
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export async function actorAllowedSubsidiaryIds(){return globalThis.__calendarAllowed}',
        }
      if (specifier === './authorization.ts')
        return {
          shortCircuit: true,
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
          export async function requireHrmLeaveRead(exec,org,actor,id){
            globalThis.__calendarGates.push(id);
            if(globalThis.__calendarRefusal) throw globalThis.__calendarRefusal;
          }
          export async function requireHrmLeaveManageOnEmployment(){throw new Error('unexpected write')}
        `),
        }
    }
    return nextResolve(specifier, context)
  },
})
const { absenceCalendarForDepartment } = await import('./attendance.ts')
const dialect = new PgDialect()
const member = (id: string, subsidiary: string, name: string) => ({
  employment_id: id,
  employer_subsidiary_id: subsidiary,
  worker_name: name,
})
const absence = (id: string, hours: string, code = 'VAC') => ({
  id,
  on_date: '2026-09-22',
  hours,
  code,
  source: 'request',
})

function executor(
  members: ReturnType<typeof member>[],
  days: Record<string, ReturnType<typeof absence>[]>,
  allowed: Set<string> | null = null,
) {
  state.__calendarAllowed = allowed
  state.__calendarGates = []
  state.__calendarRefusal = null
  const queries: { sql: string; params: unknown[] }[] = []
  const exec = {
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const compiled = dialect.sqlToQuery(query)
      queries.push(compiled)
      if (compiled.sql.includes('from worker_employments e'))
        return { rows: members }
      const employee = compiled.params.find(
        (value) => typeof value === 'string' && Object.hasOwn(days, value),
      ) as string
      return { rows: days[employee] ?? [] }
    },
  } as unknown as SqlExecutor
  return { exec, queries }
}

/** Every calendar property uses the same tenant, actor and month fixture. */
const calendar = (exec: SqlExecutor, departmentId: string | null = null) =>
  absenceCalendarForDepartment(exec, 'org', 'actor', departmentId, '2026-09-01', '2026-09-30')

test('all departments reads every authorized employment including one without a department', async () => {
  const { exec, queries } = executor(
    [
      member('sales', 'entity-a', 'Ada'),
      member('unassigned', 'entity-a', 'Grace'),
    ],
    {
      sales: [absence('a', '8.00')],
      unassigned: [absence('b', '4.00', 'SICK')],
    },
  )
  const days = await calendar(exec)
  assert.deepEqual(
    days.map((day) => day.workerName),
    ['Ada', 'Grace'],
  )
  assert.deepEqual(state.__calendarGates, ['sales', 'unassigned'])
  assert.ok(queries.every((query) => !query.sql.includes('department_id')))
  assert.match(queries[0]!.sql, /e\.org_id =/)
  assert.match(queries[1]!.sql, /a\.org_id =/)
})

test('a selected department resolves its primary assignment on each absence date', async () => {
  const { exec, queries } = executor([member('sales', 'entity-a', 'Ada')], {
    sales: [absence('a', '8.00')],
  })
  await calendar(exec, 'department-sales')
  const query = queries[1]!
  assert.ok(query.params.includes('department-sales'))
  assert.match(query.sql, /v\.org_id = a\.org_id/)
  assert.match(query.sql, /v\.effective_from <= a\.on_date/)
  assert.match(query.sql, /v\.effective_to > a\.on_date/)
  assert.match(query.sql, /v\.is_primary and v\.recorded_until is null/)
})

test('restricted readers cannot see another legal entity and an empty scope reads no rows', async () => {
  const { exec, queries } = executor(
    [
      member('sales', 'entity-a', 'Ada'),
      member('hidden', 'entity-b', 'Hidden'),
    ],
    {
      sales: [absence('a', '8.00')],
      hidden: [absence('b', '8.00')],
    },
    new Set(['entity-a']),
  )
  const days = await calendar(exec)
  assert.deepEqual(
    days.map((day) => day.workerName),
    ['Ada'],
  )
  assert.deepEqual(state.__calendarGates, ['sales'])
  assert.match(queries[0]!.sql, /e\.employer_subsidiary_id in/)
  const empty = executor([], {}, new Set())
  assert.deepEqual(
    await calendar(empty.exec),
    [],
  )
  assert.equal(empty.queries.length, 0)
})

test('reversed absences disappear and leave types retain their exact net hours', async () => {
  const { exec } = executor([member('sales', 'entity-a', 'Ada')], {
    sales: [
      absence('vac', '8.00'),
      absence('vac-reversal', '-8.00'),
      absence('sick', '7.50', 'SICK'),
    ],
  })
  const days = await calendar(exec)
  assert.equal(days.length, 1)
  assert.equal(days[0]?.leaveTypeCode, 'SICK')
  assert.equal(days[0]?.hours, '7.50')
})

test('a computed employment refusal propagates rather than returning a partial calendar', async () => {
  const { exec } = executor([member('sales', 'entity-a', 'Ada')], {
    sales: [absence('a', '8.00')],
  })
  state.__calendarRefusal = new Error(
    'access denied — ask an administrator for leave read access',
  )
  await assert.rejects(
    calendar(exec),
    /ask an administrator for leave read access/,
  )
})

test('invalid, reversed and oversized windows refuse before database access', async () => {
  for (const [from, to] of [
    ['2026-02-30', '2026-03-01'],
    ['2026-09-30', '2026-09-01'],
    ['2025-01-01', '2026-09-30'],
  ]) {
    const { exec, queries } = executor([], {})
    await assert.rejects(
      absenceCalendarForDepartment(exec, 'org', 'actor', null, from!, to!),
    )
    assert.equal(queries.length, 0)
  }
})
