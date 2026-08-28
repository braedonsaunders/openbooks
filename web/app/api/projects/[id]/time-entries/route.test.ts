import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * The detail endpoint is a direct-by-id read, so its subsidiary boundary must
 * be exercised independently of the projects list. The scripted database
 * fake deliberately returns an out-of-scope project when the query omits the
 * subsidiary predicate; that makes this regression red against the old
 * implementation rather than merely asserting a source string.
 */
const stateKey = Symbol.for('openbooks.project-time-detail-route-test')
interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  projectSubsidiary: string | null
  calls: string[]
}

const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  projectSubsidiary: null,
  calls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL query into text for the scripted responses/assertions. */
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
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksProjectTimeSqlText?: unknown }).openbooksProjectTimeSqlText = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.project-time-detail-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'projects.read') throw new Error('unexpected permission: ' + permission)
        return {
          user: { id: 'user-1', orgId: 'org-1' },
          permissions: new Set(['projects.read']),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'mock:projects-gate',
    `
      export async function guardProjectsFeature() { return null }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.project-time-detail-route-test')]
      const sqlText = globalThis.openbooksProjectTimeSqlText
      export const db = {
        execute(query) {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('from projects')) {
            // Before the fix, this query had no subsidiary predicate. Return
            // the target project to model the UUID-guessing leak.
            if (state.allowedSubsidiaryIds !== null && !text.includes('subsidiary_id')) {
              return Promise.resolve({ rows: [{ id: 'project-1' }] })
            }
            // The fixed query is evaluated against the target project's
            // subsidiary. A restricted caller cannot open a denied entity.
            if (
              state.allowedSubsidiaryIds !== null &&
              (state.projectSubsidiary === null || !state.allowedSubsidiaryIds.has(state.projectSubsidiary))
            ) {
              return Promise.resolve({ rows: [] })
            }
            return Promise.resolve({ rows: [{ id: 'project-1' }] })
          }
          if (text.includes('count(*)')) {
            return Promise.resolve({ rows: [{ entries: 1, hours: '2.5', cost: '100.00', bill: '150.00' }] })
          }
          if (text.includes('from time_entries')) {
            return Promise.resolve({
              rows: [{
                id: 'time-entry-1',
                worked_on: '2026-08-26',
                employee_name: 'Employee',
                item_name: 'Service',
                task_name: 'Task',
                time_type_name: 'Regular',
                hours: '2.5',
                is_billable: true,
                cost: '100.00',
                bill: '150.00',
                memo: null,
                field_ticket_number: null,
              }],
            })
          }
          return Promise.resolve({ rows: [] })
        },
      }
      export const schema = {}
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/projects-gate', 'mock:projects-gate'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { GET } = (await import('./route.ts')) as typeof import('./route.ts')
hooks.deregister()

const ALLOWED_SUBSIDIARY = '00000000-0000-4000-8000-00000000a001'
const DENIED_SUBSIDIARY = '00000000-0000-4000-8000-00000000b001'
const PROJECT_ID = '00000000-0000-4000-8000-00000000c001'

function reset(projectSubsidiary: string | null, allowedSubsidiaryIds: Set<string> | null): void {
  routeState.calls.length = 0
  routeState.projectSubsidiary = projectSubsidiary
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds
}

function get(): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/projects/${PROJECT_ID}/time-entries?dimension=employee&key=unassigned&page=1`),
    { params: Promise.resolve({ id: PROJECT_ID }) },
  )
}

test('GET hides a project in a restricted subsidiary, including its time detail', async () => {
  reset(DENIED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))

  const response = await get()

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Project not found' })
  assert.equal(routeState.calls.filter((text) => text.includes('from time_entries')).length, 0)
})

test('GET still returns approved detail for a project in the caller scope', async () => {
  reset(ALLOWED_SUBSIDIARY, new Set([ALLOWED_SUBSIDIARY]))

  const response = await get()

  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    entries: Array<{ id: string; hours: string }>
    totals: { entries: number; hours: string }
  }
  assert.equal(payload.entries[0]?.id, 'time-entry-1')
  assert.equal(payload.entries[0]?.hours, '2.5')
  assert.deepEqual(payload.totals, { entries: 1, hours: '2.5', cost: '100.0000', bill: '150.0000' })
  const projectQuery = routeState.calls.find((text) => text.includes('from projects'))
  assert.ok(projectQuery)
  assert.match(projectQuery, /subsidiary_id = any/)
})
