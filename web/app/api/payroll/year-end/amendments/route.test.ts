import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

interface RecordedIssue {
  revision: string
  rowIds?: readonly string[]
  note?: string | null
  reason?: string | null
  scope?: unknown
}

interface GuardCall {
  kind: 'rowIds' | 'data'
  rowIds: string[]
}

interface RouteState {
  issues: RecordedIssue[]
  gateScope: string[] | null
  guardCalls: GuardCall[]
}

const stateKey = Symbol.for('openbooks.payroll-amendments-route-test')
const state: RouteState = { issues: [], gateScope: null, guardCalls: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksPayrollAmendmentsNextResponse = NextResponse

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
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-amendments-route-test')]
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.gateScope }
      }
    `,
  ],
  [
    'mock:subsidiary-scope',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-amendments-route-test')]
      const NextResponse = globalThis.openbooksPayrollAmendmentsNextResponse
      const denied = () => new NextResponse('subsidiary scope denied', { status: 403 })
      // row-b belongs to an entity outside the restricted test scope; row-a
      // is in scope. An unrestricted gate (null) allows everything.
      export async function guardPayrollFilingRowIds(gate, country, filing, rowIds) {
        state.guardCalls.push({ kind: 'rowIds', rowIds: [...rowIds] })
        if (gate.allowedSubsidiaryIds !== null && rowIds.some((id) => id === 'row-b')) return denied()
        return null
      }
      export async function guardPayrollFilingData(gate, country, filing, data) {
        const ids = data.rows.map((row) => String(row[data.rowKey] ?? ''))
        state.guardCalls.push({ kind: 'data', rowIds: ids })
        if (gate.allowedSubsidiaryIds !== null && ids.includes('row-b')) return denied()
        return null
      }
    `,
  ],
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() {
        return [{
          country: 'CA', key: 't4',
          data: { rowKey: 'rowId', columns: [], rows: [{ rowId: 'row-a' }, { rowId: 'row-b' }] },
        }]
      }
    `,
  ],
  [
    'mock:db',
    `
      export const db = { execute: async () => ({ rows: [{ rowId: 'row-a' }] }) }
    `,
  ],
  [
    'mock:drizzle',
    `
      export function sql() { return {} }
    `,
  ],
  [
    'mock:packs',
    `
      export class PayrollPackError extends Error {}
    `,
  ],
  [
    'mock:payroll-error',
    `
      export class PayrollError extends Error {}
    `,
  ],
  [
    'mock:amendments',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-amendments-route-test')]
      export async function filingLifecycle() { return { submissions: [], rows: [] } }
      export async function recordFilingIssue(input) {
        state.issues.push(input)
        return {
          submission: {
            id: 'submission-1', revision: input.revision, revisionNumber: 2,
            issuedAt: '2026-08-28T00:00:00.000Z', slipCount: 1, artifact: null,
          },
          file: null, fileRefusal: null, corrections: [],
        }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/payroll/packs.ts', 'mock:packs'],
  ['@openbooks/engine/src/payroll/error.ts', 'mock:payroll-error'],
  ['@openbooks/engine/src/payroll/yearend.ts', 'mock:yearend'],
  ['@openbooks/engine/src/payroll/yearend-amendments.ts', 'mock:amendments'],
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

const routeUrl = './route.ts?payroll-amendments-cancellation-test'
const { POST, GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.issues.length = 0
  state.guardCalls.length = 0
  state.gateScope = null
}

function restrict(): void {
  state.gateScope = ['sub-a']
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/payroll/year-end/amendments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      country: 'CA', filing: 't4', year: 2026, rowIds: ['row-1'], ...body,
    }),
  }))
}

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end/amendments${query}`))
}

test('the API rejects a cancellation that lacks explicit confirmation', async () => {
  reset()
  const response = await post({ revision: 'cancelled', reason: 'Employee belonged to another entity' })

  assert.equal(response.status, 422)
  assert.match((await response.json()).error, /explicitly confirmed/)
  assert.deepEqual(state.issues, [])
})

test('the API rejects a blank cancellation reason before the engine is reached', async () => {
  reset()
  const response = await post({ revision: 'cancelled', confirmedCancellation: true, reason: '   ' })

  assert.equal(response.status, 422)
  assert.match((await response.json()).error, /nonblank cancellation reason/)
  assert.deepEqual(state.issues, [])
})

test('POST refuses each year cause by name, with the value and the range', async () => {
  reset()
  const cases: Array<{ year: unknown; match: RegExp[] }> = [
    { year: null, match: [/year is required/, /2020/, /2100/] },
    { year: 'abc', match: [/not a number/, /abc/, /2020/, /2100/] },
    { year: 2026.5, match: [/whole year/, /2026\.5/, /2020/, /2100/] },
    { year: 2019, match: [/2019/, /2020/, /2100/] },
    { year: 2101, match: [/2101/, /2020/, /2100/] },
  ]
  for (const { year, match } of cases) {
    const response = await post({ year, revision: 'original' })
    assert.equal(response.status, 422, `year ${String(year)} was not refused`)
    const error = (await response.json() as { error: string }).error
    for (const pattern of match) assert.match(error, pattern)
    assert.deepEqual(state.issues, [])
  }
})

test('POST accepts the boundary years 2020 and 2100', async () => {
  for (const year of [2020, 2100]) {
    reset()
    const response = await post({ year, revision: 'original' })
    assert.equal(response.status, 200, `year ${year} was not accepted`)
  }
})

test('GET refuses each year cause by name, with the value and the range', async () => {
  const cases: Array<{ query: string; match: RegExp[] }> = [
    // No year parameter at all: absent, not a range error over zero.
    { query: '?country=CA&filing=t4', match: [/year is required/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&year=abc', match: [/not a number/, /abc/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&year=2026.5', match: [/whole year/, /2026\.5/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&year=2019', match: [/2019/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&year=2101', match: [/2101/, /2020/, /2100/] },
  ]
  for (const { query, match } of cases) {
    const response = await get(query)
    assert.equal(response.status, 422, `${query} was not refused`)
    const error = (await response.json() as { error: string }).error
    for (const pattern of match) assert.match(error, pattern)
  }
})

test('GET accepts the boundary years 2020 and 2100', async () => {
  for (const year of [2020, 2100]) {
    const response = await get(`?country=CA&filing=t4&year=${year}`)
    assert.equal(response.status, 200, `year ${year} was not accepted`)
  }
})

test('a confirmed cancellation passes its trimmed reason into the filing note', async () => {
  reset()
  const response = await post({
    revision: 'cancelled',
    confirmedCancellation: true,
    reason: '  Employee belonged to the other entity  ',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(state.issues, [{
    orgId: 'org-1',
    actorId: 'user-1',
    country: 'CA',
    filingKey: 't4',
    taxYear: 2026,
    revision: 'cancelled',
    rowIds: ['row-1'],
    scope: undefined,
    note: 'Employee belonged to the other entity',
    reason: 'Employee belonged to the other entity',
  }])
})

test('a restricted original with rowIds [] is guarded on the full population, not the empty list', async () => {
  reset()
  restrict()
  const response = await post({ revision: 'original', rowIds: [] })

  assert.equal(response.status, 403)
  assert.deepEqual(state.issues, [])
  // The bypass this closes: the old code guarded only the caller list (empty
  // → allowed) while the service persisted the whole population. The full
  // population is what gets guarded now.
  assert.deepEqual(state.guardCalls, [{ kind: 'data', rowIds: ['row-a', 'row-b'] }])
})

test('a restricted original naming one in-scope row is still refused: the service files the whole return', async () => {
  reset()
  restrict()
  const response = await post({ revision: 'original', rowIds: ['row-a'] })

  assert.equal(response.status, 403)
  assert.deepEqual(state.issues, [])
  assert.deepEqual(state.guardCalls, [{ kind: 'data', rowIds: ['row-a', 'row-b'] }])
})

test('a restricted correction naming in-scope rows is allowed: it persists exactly those rows', async () => {
  reset()
  restrict()
  const response = await post({ revision: 'amended', rowIds: ['row-a'] })

  assert.equal(response.status, 200)
  assert.equal(state.issues.length, 1)
  assert.deepEqual(state.guardCalls, [{ kind: 'rowIds', rowIds: ['row-a'] }])
})

test('a restricted GET with filed history still guards the current population', async () => {
  reset()
  restrict()
  // The stored submission covers row-a only, but the current population has
  // grown row-b: the lifecycle would return row-b's label, id and status, so
  // the read is refused rather than exposing the new out-of-scope slip.
  const response = await get('?country=CA&filing=t4&year=2026')

  assert.equal(response.status, 403)
})

test('an unrestricted GET with filed history still reads', async () => {
  reset()
  const response = await get('?country=CA&filing=t4&year=2026')

  assert.equal(response.status, 200)
})
