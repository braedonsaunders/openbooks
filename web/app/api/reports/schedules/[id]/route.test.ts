import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary regression harness. The fake database models the real
// withOrgTransaction contract: writes are buffered until the callback returns,
// and an audit failure discards the mutation with it.
const stateKey = Symbol.for('openbooks.report-schedule-route-test')
interface DbCall { text: string }
interface RouteState {
  calls: DbCall[]
  committed: string[]
  pending: string[]
  inTx: boolean
  rolledBack: boolean
  withOrgTransactionCalls: number
  failOnText: string | null
  respond: (text: string) => { rows: unknown[] }
}

const state: RouteState = {
  calls: [],
  committed: [],
  pending: [],
  inTx: false,
  rolledBack: false,
  withOrgTransactionCalls: 0,
  failOnText: null,
  respond: () => ({ rows: [] }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into text for deterministic query assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextReportSchedule = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const USER_ID = '00000000-0000-4000-8000-00000000b002'
const SCHEDULE_ID = '00000000-0000-4000-8000-00000000b003'
const DEFINITION_ID = '00000000-0000-4000-8000-00000000b004'

const existingSchedule = {
  id: SCHEDULE_ID,
  org_id: ORG_ID,
  definition_id: DEFINITION_ID,
  cadence: 'daily',
  day_of_week: null,
  day_of_month: null,
  hour: 7,
  minute: 0,
  timezone: 'UTC',
  recipient_emails: ['finance@example.com'],
  filters: null,
  next_run_at: '2026-08-28T07:00:00.000Z',
  active: true,
  created_at: '2026-08-27T07:00:00.000Z',
  updated_at: '2026-08-27T07:00:00.000Z',
  created_by: USER_ID,
  updated_by: USER_ID,
}

const updatedSchedule = { ...existingSchedule, active: false, updated_by: USER_ID }

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.report-schedule-route-test')]
      const sqlText = globalThis.openbooksSqlTextReportSchedule
      const isWrite = (text) =>
        text.includes('update report_schedules') ||
        text.includes('delete from report_schedules') ||
        text.includes('insert into audit_log')
      const record = (query) => {
        const text = sqlText(query)
        state.calls.push({ text })
        if (state.failOnText && text.includes(state.failOnText)) {
          throw new Error('forced storage failure: ' + state.failOnText)
        }
        if (isWrite(text)) state[state.inTx ? 'pending' : 'committed'].push(text)
        return Promise.resolve(state.respond(text))
      }
      export const db = { execute: record }
      export async function withOrgTransaction(_orgId, work) {
        state.withOrgTransactionCalls++
        if (state.inTx) return work()
        state.inTx = true
        state.rolledBack = false
        state.pending = []
        try {
          const result = await work()
          state.committed.push(...state.pending)
          return result
        } catch (error) {
          state.rolledBack = true
          throw error
        } finally {
          state.inTx = false
          state.pending = []
        }
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?report-schedule-route-test'
const { PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.calls = []
  state.committed = []
  state.pending = []
  state.inTx = false
  state.rolledBack = false
  state.withOrgTransactionCalls = 0
  state.failOnText = null
  state.respond = (text) => {
    if (text.includes('select * from report_schedules')) return { rows: [existingSchedule] }
    if (text.includes('update report_schedules')) return { rows: [updatedSchedule] }
    return { rows: [] }
  }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/reports/schedules/${SCHEDULE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'X-Request-Id': 'req-schedule-1' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SCHEDULE_ID }) },
  )
}

function remove(body: Record<string, unknown> = {}): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/reports/schedules/${SCHEDULE_ID}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'X-Request-Id': 'req-schedule-2' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SCHEDULE_ID }) },
  )
}

test('PATCH locks the tenant schedule and commits complete reasoned before/after audit evidence', async () => {
  reset()

  const response = await patch({ active: false, reason: 'pause delivery during close' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { schedule: updatedSchedule })
  assert.equal(state.withOrgTransactionCalls, 1, 'the write is tenant-pinned')
  assert.ok(
    state.calls.some((call) => call.text.includes('select * from report_schedules') && call.text.includes('for update')),
    'the organization-scoped row is locked before mutation',
  )
  const audit = state.committed.find((text) => text.includes('insert into audit_log'))
  assert.ok(audit, 'the update audit committed with the mutation')
  assert.match(audit!, /"reason":"pause delivery during close"/)
  assert.match(audit!, /"before":/)
  assert.match(audit!, /"after":/)
  assert.match(audit!, /actor_id/)
  assert.match(audit!, /now\(\)/, 'the audit timestamp is assigned by the database')
})

test('PATCH audit failure rolls back the schedule mutation', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(() => patch({ active: false, reason: 'forced audit failure' }), /forced storage failure/)

  assert.ok(state.pending.length === 0, 'the transaction buffer was discarded')
  assert.equal(state.committed.some((text) => text.includes('update report_schedules')), false)
  assert.equal(state.rolledBack, true, 'withOrgTransaction rolled back after audit failure')
})

test('DELETE locks, retires, and audits the exact tenant schedule snapshot', async () => {
  reset()

  const response = await remove({ reason: 'retire obsolete delivery' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.ok(
    state.calls.some((call) => call.text.includes('select * from report_schedules') && call.text.includes('for update')),
    'the organization-scoped row is locked before retirement',
  )
  assert.ok(state.committed.some((text) => text.includes('delete from report_schedules')))
  const audit = state.committed.find((text) => text.includes('insert into audit_log'))
  assert.ok(audit, 'the retirement audit committed with the delete')
  assert.match(audit!, /"reason":"retire obsolete delivery"/)
  assert.match(audit!, /"before":/)
  assert.match(audit!, /"after":null/)
})

test('DELETE audit failure rolls back the retirement', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(() => remove({ reason: 'forced audit failure' }), /forced storage failure/)

  assert.ok(state.calls.some((call) => call.text.includes('delete from report_schedules')), 'the delete was attempted')
  assert.equal(state.committed.some((text) => text.includes('delete from report_schedules')), false)
  assert.equal(state.rolledBack, true, 'withOrgTransaction rolled back after audit failure')
})
