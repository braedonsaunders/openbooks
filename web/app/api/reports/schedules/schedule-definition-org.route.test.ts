import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Creating a schedule must load the definition inside the caller's
 * organization. Another org's definition id is not found — it cannot be
 * attached to this tenant's cadence or mailed as this tenant's report.
 */
const stateKey = Symbol.for('openbooks.schedule-definition-org-route-test')

interface RouteState {
  loads: Array<{ orgId: string; id: string }>
  inserts: string[]
}

const state: RouteState = { loads: [], inserts: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const USER_ID = '00000000-0000-4000-8000-00000000b002'
const HOME_DEF = '00000000-0000-4000-8000-00000000b004'
const OTHER_DEF = '00000000-0000-4000-8000-00000000b099'

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
;(globalThis as typeof globalThis & { openbooksScheduleDefOrgSqlText?: typeof sqlText }).openbooksScheduleDefOrgSqlText =
  sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.schedule-definition-org-route-test')]
      const sqlText = globalThis.openbooksScheduleDefOrgSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('insert into report_schedules')) {
            state.inserts.push(text)
            return { rows: [{ id: '00000000-0000-4000-8000-00000000b003' }] }
          }
          return { rows: [] }
        },
      }
      export async function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return {
          user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
          permissions: new Set(['reports.schedule']),
        }
      }
      export function can() { return true }
    `,
  ],
  [
    'mock:reports',
    `
      const state = globalThis[Symbol.for('openbooks.schedule-definition-org-route-test')]
      export async function loadReportDefinition(orgId, id) {
        state.loads.push({ orgId, id })
        if (orgId === '${ORG_ID}' && id === '${HOME_DEF}') {
          return {
            id: '${HOME_DEF}',
            report_type: 'query',
            query: { entity: 'documents' },
            statement: null,
            name: 'Documents',
            slug: 'documents',
            kind: 'custom',
          }
        }
        return null
      }
      export async function canAccessReportDefinition() { return true }
      export async function canAccessReportArtifact() { return true }
      export function snapshotReportAuthorization() {
        return { version: 1, userId: '${USER_ID}', allowedSubsidiaryIds: null, definition: {} }
      }
    `,
  ],
])

const root = pathToFileURL(process.cwd() + '/').href
const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/custom-reports', 'mock:reports'],
  ['../../../../lib/report-execution-context', 'mock:reports'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier === '@/lib/api/json') {
      return nextResolve(root + 'web/lib/api/json.ts', context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { POST } = (await import('./route.ts?schedule-definition-org')) as typeof import('./route.ts')
hooks.deregister()

function post(definitionId: string): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/reports/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definitionId,
        cadence: 'daily',
        hour: 9,
        minute: 0,
        timezone: 'UTC',
        recipientEmails: ['recipient@example.test'],
        active: false,
      }),
    }),
  )
}

test('POST /api/reports/schedules refuses another organization definition id', async () => {
  state.loads = []
  state.inserts = []

  const response = await post(OTHER_DEF)

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'report not found' })
  assert.deepEqual(state.loads, [{ orgId: ORG_ID, id: OTHER_DEF }])
  assert.equal(state.inserts.length, 0, 'a foreign definition must never become a tenant schedule')
})

test('POST /api/reports/schedules loads the home-organization definition before insert', async () => {
  state.loads = []
  state.inserts = []

  const response = await post(HOME_DEF)

  assert.equal(response.status, 201, await response.clone().text())
  assert.deepEqual(state.loads, [{ orgId: ORG_ID, id: HOME_DEF }])
  assert.equal(state.inserts.length, 1)
  assert.match(state.inserts[0]!, /insert into report_schedules/)
})
