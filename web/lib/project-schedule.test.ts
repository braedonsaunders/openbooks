import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface Query {
  strings: string[]
  values: unknown[]
}

interface TestState {
  orgTransactionCalls: number
  rootExecuteCalls: number
  transactionCalls: number
  commits: number
  rollbacks: number
  committedTaskInserts: number
  txQueries: Query[]
  calendarTargetExists: boolean
  resourceTargetExists: boolean
}

const stateKey = Symbol.for('openbooks.project-schedule-test')
const state: TestState = {
  orgTransactionCalls: 0,
  rootExecuteCalls: 0,
  transactionCalls: 0,
  commits: 0,
  rollbacks: 0,
  committedTaskInserts: 0,
  txQueries: [],
  calendarTargetExists: false,
  resourceTargetExists: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) { return { strings, values } }
      sql.raw = (value) => ({ raw: value })
      sql.join = (parts, separator) => ({ parts, separator })
    `,
  ],
  [
    'mock:money',
    `export function normalizeMoney(value) { return String(value) }`,
  ],
  [
    'mock:scheduling',
    `export function wouldCreateDependencyCycle() { return false }`,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.project-schedule-test')]
      function text(query) {
        return Array.isArray(query?.strings) ? query.strings.join(' ') : String(query ?? '')
      }
      function result(query) {
        const statement = text(query)
        if (/select coalesce\\(max\\(schedule_order\\)/i.test(statement)) return { rows: [{ n: 7 }] }
        if (/insert into project_tasks/i.test(statement)) return { rows: [{ id: 'task-created' }] }
        if (/select 1 from schedule_calendars/i.test(statement)) {
          return { rows: state.calendarTargetExists ? [{ id: 'calendar-target' }] : [] }
        }
        if (/update schedule_calendars[\\s\\S]*returning id/i.test(statement)) {
          return { rows: state.calendarTargetExists ? [{ id: 'calendar-target' }] : [] }
        }
        if (/delete from schedule_calendars[\\s\\S]*returning id/i.test(statement)) {
          return { rows: state.calendarTargetExists ? [{ id: 'calendar-target' }] : [] }
        }
        if (/select 1 from schedule_resources/i.test(statement)) {
          return { rows: state.resourceTargetExists ? [{ id: 'resource-target' }] : [] }
        }
        if (/update schedule_resources[\\s\\S]*returning id/i.test(statement)) {
          return { rows: state.resourceTargetExists ? [{ id: 'resource-target' }] : [] }
        }
        if (/delete from schedule_resources[\\s\\S]*returning id/i.test(statement)) {
          return { rows: state.resourceTargetExists ? [{ id: 'resource-target' }] : [] }
        }
        return { rows: [] }
      }
      const root = {
        async execute(query) {
          state.rootExecuteCalls++
          return result(query)
        },
        async transaction(callback) {
          state.transactionCalls++
          let taskInsert = false
          const tx = {
            async execute(query) {
              state.txQueries.push(query)
              if (/insert into project_tasks/i.test(text(query))) taskInsert = true
              return result(query)
            },
          }
          try {
            const value = await callback(tx)
            state.commits++
            if (taskInsert) state.committedTaskInserts++
            return value
          } catch (error) {
            state.rollbacks++
            throw error
          }
        },
      }
      async function withOrgTransaction(orgId, callback) {
        state.orgTransactionCalls++
        return callback()
      }
      export const db = root
      export { withOrgTransaction }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') return { url: 'mock:server-only', shortCircuit: true }
    if (specifier === 'drizzle-orm') return { url: 'mock:drizzle', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/money.ts') return { url: 'mock:money', shortCircuit: true }
    if (specifier === '@appkit/scheduling') return { url: 'mock:scheduling', shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const scheduleUrl = './project-schedule.ts?project-schedule-regression'
const schedule = (await import(scheduleUrl)) as typeof import('./project-schedule.ts')
hooks.deregister()

const ORG_ID = 'org-1'
const PROJECT_A = 'project-a'

function reset() {
  state.orgTransactionCalls = 0
  state.rootExecuteCalls = 0
  state.transactionCalls = 0
  state.commits = 0
  state.rollbacks = 0
  state.committedTaskInserts = 0
  state.txQueries = []
  state.calendarTargetExists = false
  state.resourceTargetExists = false
}

test('creating a task rolls back its insert when the patch fails', async () => {
  reset()

  await assert.rejects(
    schedule.createScheduleTask(
      ORG_ID,
      PROJECT_A,
      { name: 'Broken task', resourceAssignments: [{ resourceId: 'resource-1', units: 0 }] } as never,
      'user-1',
    ),
    (error: unknown) => error instanceof schedule.ScheduleError && (error as { status?: number }).status === 422,
  )

  assert.equal(state.transactionCalls, 1)
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.committedTaskInserts, 0)
  assert.equal(state.rootExecuteCalls, 0)
  assert.ok(state.txQueries.some((query) => /insert into project_tasks/i.test(query.strings.join(' '))))
})

test('calendar updates and deletes require the authorized project', async () => {
  reset()

  await assert.rejects(
    schedule.upsertScheduleCalendar(ORG_ID, PROJECT_A, { id: 'calendar-from-b', name: 'Nope' }, 'user-1'),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_calendars/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /update schedule_calendars/i.test(query.strings.join(' '))))

  reset()
  await assert.rejects(
    schedule.deleteScheduleCalendar(ORG_ID, PROJECT_A, 'calendar-from-b'),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_calendars/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /update project_tasks|update schedule_resources|delete from schedule_calendars/i.test(query.strings.join(' '))))

  reset()
  state.calendarTargetExists = true
  assert.equal(
    await schedule.upsertScheduleCalendar(ORG_ID, PROJECT_A, { id: 'calendar-a', name: 'Updated' }, 'user-1'),
    'calendar-target',
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 1)
})

test('resource updates and deletes require the authorized project', async () => {
  reset()

  await assert.rejects(
    schedule.upsertScheduleResource(ORG_ID, PROJECT_A, { id: 'resource-from-b', name: 'Nope' }, 'user-1'),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_resources/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /update schedule_resources/i.test(query.strings.join(' '))))

  reset()
  await assert.rejects(
    schedule.deleteScheduleResource(ORG_ID, PROJECT_A, 'resource-from-b'),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_resources/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /delete from schedule_task_assignments|delete from schedule_resources/i.test(query.strings.join(' '))))

  reset()
  state.resourceTargetExists = true
  assert.equal(
    await schedule.upsertScheduleResource(ORG_ID, PROJECT_A, { id: 'resource-a', name: 'Updated' }, 'user-1'),
    'resource-target',
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 1)
})
