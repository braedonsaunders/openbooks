import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  parseExpectedTaskVersion,
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from './project-work-breakdown-validation.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('WBS input validation is strict and preserves exact four-decimal values', () => {
  assert.deepEqual(
    parseWorkBreakdownTaskInput({
      code: ' 01.20 ',
      name: '  Mobilization ',
      status: 'open',
      estimatedHours: '12.125',
      estimatedCost: '101.2300',
    }),
    {
      code: '01.20',
      name: 'Mobilization',
      status: 'open',
      estimatedHours: '12.1250',
      estimatedCost: '101.2300',
    },
  )

  for (const input of [
    { name: '' },
    { name: 'Invalid status', status: 'draft' },
    { name: 'Negative hours', estimatedHours: '-1' },
    { name: 'Negative cost', estimatedCost: '-0.01' },
    { name: 'Unknown field', postedAmount: '1.00' },
  ]) {
    assert.throws(
      () => parseWorkBreakdownTaskInput(input),
      ProjectWorkBreakdownError,
    )
  }
})

test('WBS updates require a valid optimistic-concurrency version', () => {
  assert.equal(
    parseExpectedTaskVersion('2026-07-28T12:34:56.000000Z'),
    '2026-07-28T12:34:56.000000Z',
  )
  assert.throws(() => parseExpectedTaskVersion(undefined), /valid task version/)
  assert.throws(() => parseExpectedTaskVersion('not-a-date'), /valid task version/)
})

test('WBS API boundaries enforce project gates, permissions, ownership, concurrency, and audit', () => {
  const collection = source('app/api/projects/[id]/tasks/route.ts')
  const item = source('app/api/projects/[id]/tasks/[taskId]/route.ts')
  const service = source('lib/project-work-breakdown.ts')
  const projectRoute = source('app/api/projects/[id]/route.ts')

  assert.match(collection, /guardPermission\('projects\.read'\)/)
  assert.match(collection, /guardPermission\('projects\.manage'\)/)
  assert.match(collection, /guardProjectsFeature/)
  assert.match(collection, /loadWorkBreakdownTasks\(gate\.user\.orgId, id, gate\.allowedSubsidiaryIds\)/)
  assert.match(collection, /allowedSubsidiaryIds: gate\.allowedSubsidiaryIds/)
  assert.match(item, /guardPermission\('projects\.manage'\)/)
  assert.match(item, /guardProjectsFeature/)
  assert.match(item, /allowedSubsidiaryIds: gate\.allowedSubsidiaryIds/)
  assert.match(service, /project_id = \$\{args\.projectId\}/)
  assert.match(service, /org_id = \$\{args\.orgId\}/)
  assert.match(service, /= any/)
  assert.match(service, /and false/)
  assert.match(service, /for update/)
  assert.match(service, /locked snapshot comparison/)
  assert.doesNotMatch(service, /and updated_at = \$\{args\.expectedUpdatedAt\}/)
  assert.match(service, /Concurrent creates cannot both observe the same max/)
  assert.match(service, /insert into audit_log/)
  assert.match(service, /source: 'project_work_breakdown'/)
  assert.match(collection, /parseJsonBody\(request, jsonObject\)/)
  assert.match(item, /parseJsonBody\(request, jsonObject\)/)
  assert.doesNotMatch(collection, /request\.json\(/)
  assert.doesNotMatch(item, /request\.json\(/)
  assert.match(projectRoute, /must be changed through the project task endpoint/)
  assert.doesNotMatch(projectRoute, /delete from project_tasks/)
})

test('WBS drawer supports direct create, edit, refresh, canonical saves, and conflict errors', () => {
  const tab = source('app/(app)/projects/tabs/WorkBreakdownTab.tsx')

  assert.match(tab, /method: creating \? 'POST' : 'PATCH'/)
  assert.match(tab, /expectedUpdatedAt: editor\.updatedAt/)
  assert.match(tab, /cache: 'no-store'/)
  assert.match(tab, /setTasks\(\(current\)/)
  assert.match(tab, /role="alert"/)
  assert.match(tab, /stacked/)
  assert.match(tab, /router\.refresh\(\)/)
  assert.match(tab, /if \(!left\.code && right\.code\) return 1/)
})

/**
 * The WBS helper is the direct-by-id boundary for both collection handlers.
 * This scripted database deliberately returns a denied project when the
 * subsidiary predicate is absent, making the regression fail against the old
 * helper rather than merely checking a source string.
 */
const scopeStateKey = Symbol.for('openbooks.project-work-breakdown-scope-test')
interface ScopeState {
  allowedSubsidiaryIds: Set<string> | null
  projectSubsidiary: string | null
  calls: string[]
}

const scopeState: ScopeState = {
  allowedSubsidiaryIds: null,
  projectSubsidiary: null,
  calls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[scopeStateKey] = scopeState

const scopeMockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        return { strings: Array.from(strings), values }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.project-work-breakdown-scope-test')]
      function text(query) {
        if (!query || !Array.isArray(query.strings)) return ''
        return query.strings.map((part, index) => part + (query.values?.[index] && typeof query.values[index] === 'object'
          ? text(query.values[index])
          : '')).join('')
      }
      function projectRows(statement) {
        if (state.allowedSubsidiaryIds === null) return [{ id: 'project-1' }]
        // Before the fix, assertProject had no subsidiary predicate. Return
        // the target project so the old helper reaches its leaking task query.
        if (!statement.includes('subsidiary_id')) return [{ id: 'project-1' }]
        if (!state.projectSubsidiary || !state.allowedSubsidiaryIds.has(state.projectSubsidiary)) return []
        return [{ id: 'project-1' }]
      }
      function taskRows(statement) {
        if (state.allowedSubsidiaryIds !== null && !statement.includes('subsidiary_id')) {
          return [{ id: 'task-1', project_id: 'project-1', code: '01', name: 'Denied task', status: 'open', estimated_hours: '2.0000', estimated_cost: '100.0000', updated_at: '2026-08-01T00:00:00.000000Z' }]
        }
        if (state.allowedSubsidiaryIds !== null && (!state.projectSubsidiary || !state.allowedSubsidiaryIds.has(state.projectSubsidiary))) return []
        return [{ id: 'task-1', project_id: 'project-1', code: '01', name: 'Allowed task', status: 'open', estimated_hours: '2.0000', estimated_cost: '100.0000', updated_at: '2026-08-01T00:00:00.000000Z' }]
      }
      async function execute(query) {
        const statement = text(query)
        state.calls.push(statement)
        if (statement.includes('insert into project_tasks')) return { rows: [{ id: 'task-created', project_id: 'project-1', code: '02', name: 'Allowed create', status: 'open', estimated_hours: '1.0000', estimated_cost: '50.0000', updated_at: '2026-08-01T00:00:00.000000Z' }] }
        if (statement.includes('update project_tasks')) return { rows: [{ id: 'task-1', project_id: 'project-1', code: '01', name: 'Allowed update', status: 'open', estimated_hours: '3.0000', estimated_cost: '150.0000', updated_at: '2026-08-01T00:00:00.000000Z' }] }
        if (statement.includes('from project_tasks')) return { rows: taskRows(statement) }
        if (statement.includes('from projects')) return { rows: projectRows(statement) }
        return { rows: [] }
      }
      const db = {
        execute,
        async transaction(callback) {
          return callback({ execute })
        },
      }
      export { db }
    `,
  ],
])

let workBreakdown!: typeof import('./project-work-breakdown.ts')
let workBreakdownRoute!: typeof import('../app/api/projects/[id]/tasks/[taskId]/route.ts')
const ALLOWED_SUBSIDIARY = '00000000-0000-4000-8000-00000000a001'
const DENIED_SUBSIDIARY = '00000000-0000-4000-8000-00000000b001'
let resolveModules!: () => void
const modulesReady = new Promise<void>((resolve) => {
  resolveModules = resolve
})

// Register these before the top-level dynamic imports below. The repository's
// trusted runner uses --test-force-exit, which cancels tests registered after a
// top-level await even when their promises would otherwise settle.
test('WBS helper blocks reads, creates, and updates outside the caller subsidiary scope', async () => {
  await modulesReady
  await runWorkBreakdownScopeTest()
})

test('WBS PATCH returns an indistinguishable 404 before task writes for a denied subsidiary', async () => {
  await modulesReady
  await runWorkBreakdownPatchScopeTest()
})

const scopeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'mock:server-only', shortCircuit: true }
    if (specifier === 'drizzle-orm') return { url: 'mock:drizzle', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    const source = scopeMockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const scopeModuleSpecifier = './project-work-breakdown.ts?subsidiary-scope-regression' as string
workBreakdown = (await import(scopeModuleSpecifier)) as typeof import('./project-work-breakdown.ts')
scopeHooks.deregister()

const routeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes('/lib/authz')) return { url: 'mock:project-route-authz', shortCircuit: true }
    if (specifier.includes('/lib/projects-gate')) return { url: 'mock:project-route-gate', shortCircuit: true }
    if (specifier === '@/lib/api/json') return { url: 'mock:project-route-json', shortCircuit: true }
    if (specifier === 'next/server') return { url: 'mock:project-route-next-server', shortCircuit: true }
    if (specifier === 'server-only') return { url: 'mock:server-only', shortCircuit: true }
    if (specifier === 'drizzle-orm') return { url: 'mock:drizzle', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:project-route-authz') {
      return {
        format: 'module',
        source: `
          const state = globalThis[Symbol.for('openbooks.project-work-breakdown-scope-test')]
          export async function guardPermission() {
            return { user: { id: 'user-1', orgId: 'org-1' }, permissions: new Set(['*']), allowedSubsidiaryIds: state.allowedSubsidiaryIds }
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:project-route-gate') {
      return { format: 'module', source: 'export async function guardProjectsFeature() { return null }', shortCircuit: true }
    }
    if (url === 'mock:project-route-json') {
      return {
        format: 'module',
        source: `
          export const jsonObject = {}
          export async function parseJsonBody(request) { return { ok: true, data: await request.json() } }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:project-route-next-server') {
      return {
        format: 'module',
        source: `
          export class NextResponse extends Response {
            static json(data, init) {
              return new NextResponse(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
            }
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:server-only') return { format: 'module', source: '', shortCircuit: true }
    const source = scopeMockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeModuleSpecifier = '../app/api/projects/[id]/tasks/[taskId]/route.ts?subsidiary-scope-regression' as string
workBreakdownRoute = (await import(routeModuleSpecifier)) as typeof import('../app/api/projects/[id]/tasks/[taskId]/route.ts')
routeHooks.deregister()
resolveModules()

function resetScope(projectSubsidiary: string | null, allowedSubsidiaryIds: Set<string> | null): void {
  scopeState.calls.length = 0
  scopeState.projectSubsidiary = projectSubsidiary
  scopeState.allowedSubsidiaryIds = allowedSubsidiaryIds
}

async function runWorkBreakdownScopeTest(): Promise<void> {
  resetScope(DENIED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))

  await assert.rejects(
    workBreakdown.loadWorkBreakdownTasks('org-1', 'project-1', scopeState.allowedSubsidiaryIds),
    (error: unknown) => error instanceof ProjectWorkBreakdownError && error.status === 404,
  )
  await assert.rejects(
    workBreakdown.createWorkBreakdownTask({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'user-1',
      allowedSubsidiaryIds: scopeState.allowedSubsidiaryIds,
      input: {
        code: '01',
        name: 'Denied create',
        status: 'open',
        estimatedHours: '1.0000',
        estimatedCost: '50.0000',
      },
    }),
    (error: unknown) => error instanceof ProjectWorkBreakdownError && error.status === 404,
  )
  await assert.rejects(
    workBreakdown.updateWorkBreakdownTask({
      orgId: 'org-1',
      projectId: 'project-1',
      taskId: 'task-1',
      actorId: 'user-1',
      allowedSubsidiaryIds: scopeState.allowedSubsidiaryIds,
      expectedUpdatedAt: '2026-08-01T00:00:00.000000Z',
      input: {
        code: '01',
        name: 'Denied update',
        status: 'open',
        estimatedHours: '3.0000',
        estimatedCost: '150.0000',
      },
    }),
    (error: unknown) => error instanceof ProjectWorkBreakdownError && error.status === 404,
  )
  assert.equal(
    scopeState.calls.filter(
      (statement) => statement.includes('insert into project_tasks') || statement.includes('update project_tasks'),
    ).length,
    0,
  )
  assert.equal(scopeState.calls.filter((statement) => statement.includes('from project_tasks')).length, 0)
  assert.equal(scopeState.calls.filter((statement) => statement.includes('insert into audit_log')).length, 0)

  resetScope(ALLOWED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))
  const tasks = await workBreakdown.loadWorkBreakdownTasks('org-1', 'project-1', scopeState.allowedSubsidiaryIds)
  assert.equal(tasks[0]?.name, 'Allowed task')
  const created = await workBreakdown.createWorkBreakdownTask({
    orgId: 'org-1',
    projectId: 'project-1',
    actorId: 'user-1',
    allowedSubsidiaryIds: scopeState.allowedSubsidiaryIds,
    input: {
      code: '02',
      name: 'Allowed create',
      status: 'open',
      estimatedHours: '1.0000',
      estimatedCost: '50.0000',
    },
  })
  assert.equal(created.name, 'Allowed create')
  const updated = await workBreakdown.updateWorkBreakdownTask({
    orgId: 'org-1',
    projectId: 'project-1',
    taskId: 'task-1',
    actorId: 'user-1',
    allowedSubsidiaryIds: scopeState.allowedSubsidiaryIds,
    expectedUpdatedAt: '2026-08-01T00:00:00.000000Z',
    input: {
      code: '01',
      name: 'Allowed update',
      status: 'open',
      estimatedHours: '3.0000',
      estimatedCost: '150.0000',
    },
  })
  assert.equal(updated.name, 'Allowed update')
  assert.ok(scopeState.calls.some((statement) => statement.includes('subsidiary_id = any')))

  resetScope(null, null)
  const unrestricted = await workBreakdown.loadWorkBreakdownTasks('org-1', 'project-1', null)
  assert.equal(unrestricted[0]?.name, 'Allowed task')
}

async function runWorkBreakdownPatchScopeTest(): Promise<void> {
  resetScope(DENIED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))

  const response = await workBreakdownRoute.PATCH(
    new Request('http://localhost/api/projects/00000000-0000-4000-8000-00000000c001/tasks/00000000-0000-4000-8000-00000000d001', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '01',
        name: 'Denied route update',
        status: 'open',
        estimatedHours: '3.0000',
        estimatedCost: '150.0000',
        expectedUpdatedAt: '2026-08-01T00:00:00.000000Z',
      }),
    }),
    { params: Promise.resolve({ id: '00000000-0000-4000-8000-00000000c001', taskId: '00000000-0000-4000-8000-00000000d001' }) },
  )

  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'not found')
  assert.equal(scopeState.calls.filter((statement) => statement.includes('from project_tasks')).length, 0)
  assert.equal(
    scopeState.calls.filter(
      (statement) => statement.includes('insert into project_tasks') || statement.includes('update project_tasks'),
    ).length,
    0,
  )
  assert.equal(scopeState.calls.filter((statement) => statement.includes('insert into audit_log')).length, 0)

  resetScope(ALLOWED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))
  const allowedResponse = await workBreakdownRoute.PATCH(
    new Request('http://localhost/api/projects/00000000-0000-4000-8000-00000000c001/tasks/00000000-0000-4000-8000-00000000d001', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '01',
        name: 'Allowed route update',
        status: 'open',
        estimatedHours: '3.0000',
        estimatedCost: '150.0000',
        expectedUpdatedAt: '2026-08-01T00:00:00.000000Z',
      }),
    }),
    { params: Promise.resolve({ id: '00000000-0000-4000-8000-00000000c001', taskId: '00000000-0000-4000-8000-00000000d001' }) },
  )

  assert.equal(allowedResponse.status, 200)
  assert.equal((await allowedResponse.json()).task.name, 'Allowed update')
  assert.ok(scopeState.calls.some((statement) => statement.includes('update project_tasks')))
  assert.ok(scopeState.calls.some((statement) => statement.includes('insert into audit_log')))
}
