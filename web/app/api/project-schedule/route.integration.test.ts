import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface RouteState {
  authz: {
    user: { orgId: string; id: string }
    permissions: Set<string>
    allowedSubsidiaryIds: null
  } | null
  calendarArgs: unknown[] | null
  resourceArgs: unknown[] | null
}

const stateKey = Symbol.for('openbooks.project-schedule-route-test')
const state: RouteState = {
  authz: null,
  calendarArgs: null,
  resourceArgs: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:next-server',
    `
      export class NextResponse extends Response {
        static json(body, init = {}) {
          const headers = new Headers(init.headers)
          headers.set('content-type', 'application/json')
          return new Response(JSON.stringify(body), { ...init, headers })
        }
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.project-schedule-route-test')]
      export async function guardPermission() {
        if (!state.authz) return new Response(null, { status: 403 })
        return state.authz
      }
    `,
  ],
  [
    'mock:feature-gate',
    `export async function guardProjectSchedulingFeature() { return null }`,
  ],
  [
    'mock:db',
    `
      export const db = {
        async execute() {
          return { rows: [{ id: '00000000-0000-0000-0000-000000000001', subsidiary_id: null }] }
        },
      }
    `,
  ],
  [
    'mock:drizzle',
    `export function sql(strings, ...values) { return { strings, values } }`,
  ],
  [
    'mock:schedule',
    `
      const state = globalThis[Symbol.for('openbooks.project-schedule-route-test')]
      export class ScheduleError extends Error {}
      export async function batchUpdateScheduleTasks() {}
      export async function createScheduleBaseline() {}
      export async function createScheduleDependency() {}
      export async function createScheduleTask() {}
      export async function deleteScheduleBaseline() {}
      export async function deleteScheduleDependency() {}
      export async function deleteScheduleTask() {}
      export async function loadProjectSchedule() {}
      export async function updateScheduleTask() {}
      export async function upsertScheduleCalendar() {}
      export async function upsertScheduleResource() {}
      export async function deleteScheduleCalendar(...args) { state.calendarArgs = args }
      export async function deleteScheduleResource(...args) { state.resourceArgs = args }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return { url: 'mock:next-server', shortCircuit: true }
    if (specifier === '@/lib/api/json') return { url: 'mock:json', shortCircuit: true }
    if (specifier === '../../../lib/authz') return { url: 'mock:authz', shortCircuit: true }
    if (specifier === '../../../lib/projects-gate') return { url: 'mock:feature-gate', shortCircuit: true }
    if (specifier === '../../../lib/project-schedule') return { url: 'mock:schedule', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === 'drizzle-orm') return { url: 'mock:drizzle', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?project-schedule-route-regression'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const ORG_ID = '00000000-0000-0000-0000-000000000010'
const PROJECT_A = '00000000-0000-0000-0000-000000000001'
const FOREIGN_ID = '00000000-0000-0000-0000-000000000002'

test('delete actions forward the authorized project boundary to schedule helpers', async () => {
  state.authz = {
    user: { orgId: ORG_ID, id: '00000000-0000-0000-0000-000000000011' },
    permissions: new Set(['projects.manage']),
    allowedSubsidiaryIds: null,
  }

  state.calendarArgs = null
  const calendarResponse = await POST(new Request('http://openbooks.test/api/project-schedule', {
    method: 'POST',
    body: JSON.stringify({ projectId: PROJECT_A, action: 'deleteCalendar', id: FOREIGN_ID }),
  }))
  assert.equal(calendarResponse.status, 200)
  assert.deepEqual(state.calendarArgs, [ORG_ID, PROJECT_A, FOREIGN_ID])

  state.resourceArgs = null
  const resourceResponse = await POST(new Request('http://openbooks.test/api/project-schedule', {
    method: 'POST',
    body: JSON.stringify({ projectId: PROJECT_A, action: 'deleteResource', id: FOREIGN_ID }),
  }))
  assert.equal(resourceResponse.status, 200)
  assert.deepEqual(state.resourceArgs, [ORG_ID, PROJECT_A, FOREIGN_ID])
})
