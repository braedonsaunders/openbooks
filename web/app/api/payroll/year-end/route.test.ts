import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const mockSources = new Map<string, string>([
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
      export async function guardPayrollYearEndFilings() { return null }
    `,
  ],
  [
    'mock:yearend',
    `
      export async function orgYearEndFilings() { return [] }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/payroll-yearend.ts', 'mock:yearend'],
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

const routeUrl = './route.ts?payroll-year-end-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end${query}`))
}

test('refuses each year cause by name, with the value and the range', async () => {
  const cases: Array<{ query: string; match: RegExp[] }> = [
    // No year parameter at all: absent, not a range error over zero.
    { query: '', match: [/year is required/, /2020/, /2100/] },
    { query: '?year=abc', match: [/not a number/, /abc/, /2020/, /2100/] },
    { query: '?year=2026.5', match: [/whole year/, /2026\.5/, /2020/, /2100/] },
    { query: '?year=2019', match: [/2019/, /2020/, /2100/] },
    { query: '?year=2101', match: [/2101/, /2020/, /2100/] },
  ]
  for (const { query, match } of cases) {
    const response = await get(query)
    assert.equal(response.status, 422, `${query || '(no query)'} was not refused`)
    const error = (await response.json() as { error: string }).error
    for (const pattern of match) assert.match(error, pattern)
  }
})

test('accepts the boundary years 2020 and 2100', async () => {
  for (const year of [2020, 2100]) {
    const response = await get(`?year=${year}`)
    assert.equal(response.status, 200, `year ${year} was not accepted`)
  }
})
