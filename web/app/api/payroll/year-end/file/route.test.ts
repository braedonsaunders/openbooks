import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
      export async function guardPayrollRoeEmployees() { return null }
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
    'mock:registry',
    `
      export function yearEndFiling(country, filing) {
        return {
          label: \`\${country} \${filing}\`,
          download: {
            build: async () => ({
              body: 'file-bytes', contentType: 'text/plain', filename: 'filing.txt',
            }),
          },
        }
      }
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
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/payroll-yearend.ts', 'mock:yearend'],
  ['@openbooks/engine/src/payroll-filing-registry.ts', 'mock:registry'],
  ['@openbooks/engine/src/payroll/packs.ts', 'mock:packs'],
  ['@openbooks/engine/src/payroll-run.ts', 'mock:payroll-error'],
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

const routeUrl = './route.ts?payroll-year-end-file-test'
const { GET, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end/file${query}`))
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/payroll/year-end/file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ country: 'CA', filing: 't4', year: 2026, ...body }),
  }))
}

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

test('POST refuses each year cause by name, with the value and the range', async () => {
  const cases: Array<{ year: unknown; match: RegExp[] }> = [
    { year: null, match: [/year is required/, /2020/, /2100/] },
    { year: 'abc', match: [/not a number/, /abc/, /2020/, /2100/] },
    { year: 2026.5, match: [/whole year/, /2026\.5/, /2020/, /2100/] },
    { year: 2019, match: [/2019/, /2020/, /2100/] },
    { year: 2101, match: [/2101/, /2020/, /2100/] },
  ]
  for (const { year, match } of cases) {
    const response = await post({ year })
    assert.equal(response.status, 422, `year ${String(year)} was not refused`)
    const error = (await response.json() as { error: string }).error
    for (const pattern of match) assert.match(error, pattern)
  }
})

test('GET and POST accept the boundary years 2020 and 2100', async () => {
  for (const year of [2020, 2100]) {
    const getResponse = await get(`?country=CA&filing=t4&year=${year}`)
    assert.equal(getResponse.status, 200, `GET year ${year} was not accepted`)
    const postResponse = await post({ year })
    assert.equal(postResponse.status, 200, `POST year ${year} was not accepted`)
  }
})
