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
      export async function guardPayrollFilingData() { return null }
      export async function guardPayrollFilingRowIds() { return null }
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
          slip: { build: async () => ({ formCode: 'T4' }) },
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
  [
    'mock:business-date',
    `
      export async function businessToday() { return '2026-09-19' }
    `,
  ],
  [
    'mock:export',
    `
      export function pdfResponse() { return new Response('pdf') }
      export function safeName(value) { return String(value) }
    `,
  ],
  [
    'mock:facsimile',
    `
      export function payrollSlipFacsimile() { return { result: {}, layout: {} } }
    `,
  ],
  [
    'mock:tax-form',
    `
      export async function renderTaxFormFacsimilePdf() { return new Uint8Array() }
    `,
  ],
  [
    'mock:branding',
    `
      export async function orgBranding() {
        return { orgName: 'ReviewOrg', baseCurrency: 'CAD', primaryColor: '#000000' }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../subsidiary-scope', 'mock:subsidiary-scope'],
  ['@openbooks/engine/src/payroll/yearend.ts', 'mock:yearend'],
  ['@openbooks/engine/src/payroll/filing-registry.ts', 'mock:registry'],
  ['@openbooks/engine/src/payroll/packs.ts', 'mock:packs'],
  ['@openbooks/engine/src/payroll/run.ts', 'mock:payroll-error'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['../../../../../lib/export', 'mock:export'],
  ['../../../../../lib/payroll-slip-facsimile', 'mock:facsimile'],
  ['../../../../../lib/tax-form-facsimile', 'mock:tax-form'],
  ['../../../../../lib/report-pdf', 'mock:branding'],
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

const routeUrl = './route.ts?payroll-year-end-slip-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end/slip${query}`))
}

test('refuses each year cause by name, with the value and the range', async () => {
  const cases: Array<{ query: string; match: RegExp[] }> = [
    // No year parameter at all: absent, not a range error over zero.
    { query: '?country=CA&filing=t4&row=r1', match: [/year is required/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&row=r1&year=abc', match: [/not a number/, /abc/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&row=r1&year=2026.5', match: [/whole year/, /2026\.5/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&row=r1&year=2019', match: [/2019/, /2020/, /2100/] },
    { query: '?country=CA&filing=t4&row=r1&year=2101', match: [/2101/, /2020/, /2100/] },
  ]
  for (const { query, match } of cases) {
    const response = await get(query)
    assert.equal(response.status, 422, `${query} was not refused`)
    const error = (await response.json() as { error: string }).error
    for (const pattern of match) assert.match(error, pattern)
  }
})

test('accepts the boundary years 2020 and 2100', async () => {
  for (const year of [2020, 2100]) {
    const response = await get(`?country=CA&filing=t4&row=r1&year=${year}`)
    assert.equal(response.status, 200, `year ${year} was not accepted`)
  }
})
