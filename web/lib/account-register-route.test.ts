import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.account-register-route-test')
const routeState = { accountRegisterCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:list-params',
    `export function isUuid() { return true }`,
  ],
  [
    'mock:reports',
    `
      const state = globalThis[Symbol.for('openbooks.account-register-route-test')]
      export async function accountRegister() {
        state.accountRegisterCalls += 1
        return { account: { number: '1000', name: 'Cash' }, lines: [], total: 0, balance: '0' }
      }
    `,
  ],
  [
    'mock:account-register-export',
    `
      export function accountRegisterDocTypeLabel() { return '' }
      export function accountRegisterExportData() { return {} }
    `,
  ],
  [
    'mock:report-pdf',
    `
      export function exportDataToCsv() { return '' }
      export async function exportDataToPdf() { return Buffer.from([]) }
      export async function exportDataToXlsx() { return Buffer.from([]) }
      export async function orgBranding() { return {} }
    `,
  ],
  [
    'mock:report-labels',
    `export async function reportCsvOptions() { return {} }`,
  ],
  [
    'mock:export',
    `
      export function csvResponse() { return new Response('') }
      export function pdfResponse() { return new Response('') }
      export function safeName(value) { return value }
      export function xlsxResponse() { return new Response('') }
    `,
  ],
  [
    'mock:statement-format',
    `
      export function decimalCmp() { return 0 }
      export function decimalSum() { return '0' }
    `,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-28' }`,
  ],
  [
    'mock:pdf',
    `export function resolvePdfPageSetup() { return {} }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../lib/reports', 'mock:reports'],
  ['../../../../../lib/account-register-export', 'mock:account-register-export'],
  ['../../../../../lib/report-pdf', 'mock:report-pdf'],
  ['../../../../../lib/report-labels', 'mock:report-labels'],
  ['../../../../../lib/export', 'mock:export'],
  ['../../../../../lib/statement-format', 'mock:statement-format'],
  ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
  ['@openbooks/pdf', 'mock:pdf'],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const routeUrl = '../app/api/accounts/[id]/register/route.ts?account-register-date-test'
const { GET } = (await import(routeUrl)) as typeof import('../app/api/accounts/[id]/register/route.ts')
hooks.deregister()

const ACCOUNT_ID = '00000000-0000-4000-8000-00000000a001'

function reset(): void {
  routeState.accountRegisterCalls = 0
}

function get(query = ''): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/accounts/${ACCOUNT_ID}/register${query}`),
    { params: Promise.resolve({ id: ACCOUNT_ID }) },
  )
}

test('GET rejects an impossible date before account-register SQL runs', async () => {
  reset()

  const response = await get('?from=2026-99-99')

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_period' })
  assert.equal(routeState.accountRegisterCalls, 0)
})

test('GET accepts a real date and returns the register payload', async () => {
  reset()

  const response = await get('?from=2026-02-28&to=2026-02-28')

  assert.equal(response.status, 200)
  assert.equal(routeState.accountRegisterCalls, 1)
  assert.equal((await response.json()).page, 1)
})
