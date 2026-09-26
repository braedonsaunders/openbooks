import assert from 'node:assert/strict'
import { stubModules } from '../../../../../../testing/stub-modules'
import test from 'node:test'

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../../lib/feature-gates": `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
    "../../../subsidiary-scope": `
      export async function guardPayrollFilingRowIds() { return null }
    `,
    "@openbooks/engine/src/payroll/yearend-amendments.ts": `
      export async function filingCorrectionSlip() { return { formCode: 'T4C' } }
    `,
    "@openbooks/engine/src/payroll/packs.ts": `
      export class PayrollPackError extends Error {}
    `,
    "@openbooks/engine/src/payroll/error.ts": `
      export class PayrollError extends Error {}
    `,
    "@openbooks/engine/src/platform/business-date.ts": `
      export async function businessToday() { return '2026-09-19' }
    `,
    "../../../../../../lib/export": `
      export function pdfResponse() { return new Response('pdf') }
      export function safeName(value) { return String(value) }
    `,
    "../../../../../../lib/payroll-slip-facsimile": `
      export function payrollSlipFacsimile() { return { result: {}, layout: {} } }
    `,
    "../../../../../../lib/tax-form-facsimile": `
      export async function renderTaxFormFacsimilePdf() { return new Uint8Array() }
    `,
    "../../../../../../lib/report-pdf": `
      export async function orgBranding() {
        return { orgName: 'ReviewOrg', baseCurrency: 'CAD', primaryColor: '#000000' }
      }
    `,
  },
})

const routeUrl = './route.ts?payroll-amendments-slip-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/payroll/year-end/amendments/slip${query}`))
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
    const response = await get(`?country=CA&filing=t4&row=r1&revision=amended&year=${year}`)
    assert.equal(response.status, 200, `year ${year} was not accepted`)
  }
})
