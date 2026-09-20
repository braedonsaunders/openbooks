import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

interface RecordedIssue {
  revision: string
  rowIds?: readonly string[]
  note?: string | null
  reason?: string | null
}

interface RouteState {
  issues: RecordedIssue[]
}

const stateKey = Symbol.for('openbooks.payroll-amendments-route-test')
const state: RouteState = { issues: [] }
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
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:subsidiary-scope',
    `
      export async function guardPayrollFilingRowIds() { return null }
      export async function guardPayrollFilingData() { return null }
    `,
  ],
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() { return [] }
    `,
  ],
  [
    'mock:db',
    `
      export const db = { execute: async () => ({ rows: [] }) }
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
    note: 'Employee belonged to the other entity',
    reason: 'Employee belonged to the other entity',
  }])
})
