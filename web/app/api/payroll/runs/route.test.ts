import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  scheduleSubsidiaryId: string | null
  createCalls: Record<string, unknown>[]
  queries: string[]
}

const stateKey = Symbol.for('openbooks.payroll-runs-route-test')
const routeState: RouteState = {
  allowedSubsidiaryIds: new Set(['sub-visible']),
  scheduleSubsidiaryId: 'sub-visible',
  createCalls: [],
  queries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksPayrollRunsNextResponse = NextResponse
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksPayrollRunsSqlText = sqlText

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

const mockSources = new Map<string, string>([
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
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-runs-route-test')]
      const sqlText = globalThis.openbooksPayrollRunsSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from pay_schedules')) {
            return { rows: [{ subsidiaryId: state.scheduleSubsidiaryId }] }
          }
          if (text.includes('from subsidiaries')) return { rows: [{ id: 'sub-root' }] }
          return { rows: [] }
        },
      }
      export const schema = {}
      export const env = {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-runs-route-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-runs-route-test')]
      const NextResponse = globalThis.openbooksPayrollRunsNextResponse
      export function guardSubsidiaryScope(_gate, subsidiaryId) {
        if (state.allowedSubsidiaryIds !== null && !state.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
        return null
      }
      export function subsidiaryScopeAllows(scope, subsidiaryId, opts = {}) {
        if (scope === null) return true
        if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === '') return opts.orgWideNull === true
        return scope.has(subsidiaryId)
      }
    `,
  ],
  [
    'mock:subsidiaries',
    `
      export function subsidiaryVisibleFilter() { return '' }
    `,
  ],
  [
    'mock:payroll-run',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-runs-route-test')]
      export class PayrollError extends Error {}
      export async function createPayRun(input) {
        state.createCalls.push(input)
        return { documentId: 'doc-1', documentNumber: 'PAY-1' }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payroll-run.ts', 'mock:payroll-run'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/subsidiaries', 'mock:subsidiaries'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const routeUrl = './route.ts?payroll-runs-subsidiary-scope-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const SCHEDULE_ID = '00000000-0000-4000-8000-000000000001'

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds
  routeState.scheduleSubsidiaryId = 'sub-visible'
  routeState.createCalls = []
  routeState.queries = []
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/payroll/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('POST forwards a restricted caller scope into the atomic engine guard', async () => {
  reset(new Set(['sub-visible']))

  const response = await post({ payScheduleId: SCHEDULE_ID })

  assert.equal(response.status, 200)
  assert.equal(routeState.createCalls.length, 1)
  assert.deepEqual(routeState.createCalls[0]!.allowedSubsidiaryIds, new Set(['sub-visible']))
  assert.ok(routeState.queries.some((query) => query.includes('from pay_schedules')))
})

test('POST keeps unrestricted callers unrestricted', async () => {
  reset(null)

  const response = await post({ payScheduleId: SCHEDULE_ID })

  assert.equal(response.status, 200)
  assert.equal(routeState.createCalls[0]!.allowedSubsidiaryIds, null)
  assert.deepEqual(routeState.queries, [])
})
