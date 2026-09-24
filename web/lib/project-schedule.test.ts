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
  /** Row the in-transaction project lock sees (null = missing project). */
  projectRow: { id: string; subsidiary_id: string | null } | null
  allowedSubsidiaryIds: Set<string> | null
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
  projectRow: { id: 'project-a', subsidiary_id: 'sub-a' },
  allowedSubsidiaryIds: null,
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
        // The in-transaction project lock (subsidiary recheck): served like
        // any other locked row so scope decisions run against it.
        if (/from projects p/i.test(statement)) {
          const row = state.projectRow
          const inScope = state.allowedSubsidiaryIds === null
            || (row?.subsidiary_id !== null && row?.subsidiary_id !== undefined
              && state.allowedSubsidiaryIds.has(row.subsidiary_id))
          return { rows: row && inScope ? [row] : [] }
        }
        if (/select coalesce\\(max\\(schedule_order\\)/i.test(statement)) return { rows: [{ n: 7 }] }
        if (/insert into project_tasks/i.test(statement)) return { rows: [{ id: 'task-created' }] }
        if (/select 1 from project_tasks/i.test(statement)) return { rows: [{ id: 'task-1' }] }
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
    if (specifier === '@openbooks/engine/src/platform/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === './features') return { url: 'mock:features', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/organization/org-feature-lock.ts') return { url: 'mock:org-feature-lock', shortCircuit: true }
    if (specifier === '@braedonsaunders/appkit-scheduling') return { url: 'mock:scheduling', shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    if (url === 'mock:features') return { format: 'module', source: 'export async function isFeatureEnabled() { return true }; export async function acquireFeatureGateLock() {}', shortCircuit: true }
    if (url === 'mock:org-feature-lock') return { format: 'module', source: 'export async function lockAndCheckOrgFeature() { return true }', shortCircuit: true }
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
  state.projectRow = { id: 'project-a', subsidiary_id: 'sub-a' }
  state.allowedSubsidiaryIds = null
}

test('creating a task rolls back its insert when the patch fails', async () => {
  reset()

  await assert.rejects(
    schedule.createScheduleTask(
      ORG_ID,
      PROJECT_A,
      { name: 'Broken task', resourceAssignments: [{ resourceId: 'resource-1', units: 0 }] } as never,
      'user-1',
      null,
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

test('single-task resource replacement is atomic when a later assignment is invalid', async () => {
  reset()

  await assert.rejects(
    schedule.updateScheduleTask(
      ORG_ID,
      PROJECT_A,
      'task-1',
      { resourceAssignments: [
        { resourceId: 'resource-1', units: 1 },
        { resourceId: 'resource-2', units: 0 },
      ] } as never,
      'user-1',
      null,
    ),
    (error: unknown) => error instanceof schedule.ScheduleError && (error as { status?: number }).status === 422,
  )

  assert.equal(state.transactionCalls, 1, 'the replacement must run inside one transaction')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /delete from schedule_task_assignments/i.test(query.strings.join(' '))))
  assert.ok(!state.rootExecuteCalls || state.rootExecuteCalls === 1, 'only the authorization read may use the root executor')
})

test('calendar updates and deletes require the authorized project', async () => {
  reset()

  await assert.rejects(
    schedule.upsertScheduleCalendar(ORG_ID, PROJECT_A, { id: 'calendar-from-b', name: 'Nope' }, 'user-1', null),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_calendars/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /update schedule_calendars/i.test(query.strings.join(' '))))

  reset()
  await assert.rejects(
    schedule.deleteScheduleCalendar(ORG_ID, PROJECT_A, 'calendar-from-b', null),
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
    await schedule.upsertScheduleCalendar(ORG_ID, PROJECT_A, { id: 'calendar-a', name: 'Updated' }, 'user-1', null),
    'calendar-target',
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 1)
})

test('resource updates and deletes require the authorized project', async () => {
  reset()

  await assert.rejects(
    schedule.upsertScheduleResource(ORG_ID, PROJECT_A, { id: 'resource-from-b', name: 'Nope' }, 'user-1', null),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(state.txQueries.some((query) => /select 1 from schedule_resources/i.test(query.strings.join(' '))))
  assert.ok(!state.txQueries.some((query) => /update schedule_resources/i.test(query.strings.join(' '))))

  reset()
  await assert.rejects(
    schedule.deleteScheduleResource(ORG_ID, PROJECT_A, 'resource-from-b', null),
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
    await schedule.upsertScheduleResource(ORG_ID, PROJECT_A, { id: 'resource-a', name: 'Updated' }, 'user-1', null),
    'resource-target',
  )
  assert.equal(state.orgTransactionCalls, 1)
  assert.equal(state.commits, 1)
})

test('a write for an out-of-scope project refuses inside the transaction', async () => {
  reset()

  // The project sits in sub-a; the caller sees only sub-b. The lock runs
  // inside the write transaction, so nothing is written and the denial
  // answers exactly like the route's own 404.
  state.allowedSubsidiaryIds = new Set(['sub-b'])
  await assert.rejects(
    schedule.createScheduleTask(
      ORG_ID,
      PROJECT_A,
      { name: 'Foreign task' } as never,
      'user-1',
      new Set(['sub-b']),
    ),
    (error: unknown) => error instanceof schedule.ScheduleError && (error as { status?: number }).status === 404,
  )
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.ok(!state.txQueries.some((query) => /insert into project_tasks/i.test(query.strings.join(' '))))
})

test('a write for a missing project refuses inside the transaction', async () => {
  reset()
  state.projectRow = null

  await assert.rejects(
    schedule.deleteScheduleCalendar(ORG_ID, PROJECT_A, 'calendar-a', new Set(['sub-a'])),
    (error: unknown) => error instanceof schedule.ScheduleError && (error as { status?: number }).status === 404,
  )
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
})

test('an in-scope write still commits', async () => {
  reset()
  state.calendarTargetExists = true
  assert.equal(
    await schedule.upsertScheduleCalendar(ORG_ID, PROJECT_A, { id: 'calendar-a', name: 'Updated' }, 'user-1', new Set(['sub-a'])),
    'calendar-target',
  )
  assert.equal(state.commits, 1)
})

test('an out-of-scope project refuses before reading schedule children', async () => {
  for (const attempt of [
    () => schedule.deleteScheduleTask(ORG_ID, PROJECT_A, 'task-from-b', new Set(['sub-a'])),
    () => schedule.batchUpdateScheduleTasks(
      ORG_ID,
      PROJECT_A,
      [{ id: 'task-from-b', name: 'Changed' }],
      'user-1',
      new Set(['sub-a']),
    ),
    () => schedule.createScheduleDependency(
      ORG_ID,
      PROJECT_A,
      { predecessorId: 'task-from-b', successorId: 'other-task' },
      'user-1',
      new Set(['sub-a']),
    ),
  ]) {
    reset()
    state.projectRow = { id: PROJECT_A, subsidiary_id: 'sub-b' }
    state.allowedSubsidiaryIds = new Set(['sub-a'])

    await assert.rejects(
      attempt(),
      (error: unknown) => error instanceof schedule.ScheduleError && (error as { status?: number }).status === 404,
    )
    assert.equal(state.commits, 0)
    assert.equal(state.rollbacks, 1)
    assert.equal(state.rootExecuteCalls, 0, 'no child lookup may run outside the checked snapshot')
    assert.ok(!state.txQueries.some((query) =>
      /project_tasks|time_entries|schedule_dependencies/i.test(query.strings.join(' '))),
    'the project scope refusal must happen before a task or schedule lookup')
  }
})
