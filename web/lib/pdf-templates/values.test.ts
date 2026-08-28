import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface StubRow {
  id: string
  employee_party_id: string
  currency_code: string
  tax_year: number
  pay_date: string
  gross: string
  net_pay: string
  vacation_accrued: string
  province: string
  employee_name: string
  employee_email: string
  document_number: string
  period_start: string
  period_end: string
}

const state = {
  ytdQuery: '',
  stub: {
    id: 'stub-us-1',
    employee_party_id: 'employee-1',
    currency_code: 'USD',
    tax_year: 2026,
    pay_date: '2026-07-21',
    gross: '4000.0000',
    net_pay: '3281.6900',
    vacation_accrued: '0.0000',
    province: 'TX',
    employee_name: 'US Employee',
    employee_email: 'employee@example.test',
    document_number: 'PAY-0001',
    period_start: '2026-07-05',
    period_end: '2026-07-18',
  } satisfies StubRow,
}

const harness = {
  async execute(query: { text?: string }) {
    const text = String(query.text ?? '')
    if (text.includes('select s.*, r.period_start')) {
      return { rows: [state.stub] }
    }
    if (text.includes('select l.kind, l.description')) {
      return {
        rows: [
          { kind: 'earning', description: 'Regular', hours: '80', rate: '50', amount: '4000.0000' },
          { kind: 'deduction', description: 'Federal income tax', hours: null, rate: null, amount: '312.3100' },
        ],
      }
    }
    if (text.includes('select coalesce(sum(s.gross)')) {
      state.ytdQuery = text
      // Model the pre-fix production behavior: if FIT is not part of the
      // aggregation, a US-only stub has no Canadian T factor and reads as 0.
      const tax = text.includes("factors->>'FIT'") ? '312.3100' : '0'
      return { rows: [{ gross: '4000.0000', net: '3281.6900', tax }] }
    }
    if (text.includes('select name, base_currency')) {
      return { rows: [{ name: 'Example Org', base_currency: 'USD', brand_primary: null }] }
    }
    throw new Error(`unexpected query in pay-stub values test: ${text}`)
  },
}

;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.pay-stub-values-test')] = harness

const mockSources = new Map<string, string>([
  ['mock:server-only', 'export {}'],
  [
    'mock:drizzle-orm',
    `
      export function sql(strings, ...values) {
        return { text: strings.join('?'), values }
      }
    `,
  ],
  [
    'mock:db',
    `
      const harness = globalThis[Symbol.for('openbooks.pay-stub-values-test')]
      export const db = { execute: (query) => harness.execute(query) }
    `,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-07-22' }`,
  ],
  [
    'mock:money',
    `
      export function add(a, b) { return String(Number(a) + Number(b)) }
      export function cmp(a, b) { return Number(a) === Number(b) ? 0 : Number(a) > Number(b) ? 1 : -1 }
      export function isZero(value) { return Number(value) === 0 }
      export function mul(a, b) { return String(Number(a) * Number(b)) }
      export function neg(value) { return String(-Number(value)) }
      export function sum(values) { return String(values.reduce((total, value) => total + Number(value), 0)) }
    `,
  ],
  [
    'mock:payroll-cheques',
    `export function amountInWords(value) { return String(value) }`,
  ],
  [
    'mock:money-format',
    `
      export function createMoneyFormatter(locale, currency) {
        return {
          locale,
          money(value) {
            return new Intl.NumberFormat('en-US', {
              style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
            }).format(Number(value))
          },
        }
      }
    `,
  ],
  [
    'mock:locale',
    `export async function resolveLocale() { return 'en-US' }`,
  ],
  [
    'mock:catalog',
    `
      export const PDF_RECORD_TYPE_BY_KEY = {
        pay_stub: { key: 'pay_stub', docKind: null, docTitle: 'Pay Stub' },
      }
    `,
  ],
  [
    'mock:field-tickets',
    `export async function loadFieldTicket() { throw new Error('not used in pay-stub test') }`,
  ],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      'server-only': 'mock:server-only',
      'drizzle-orm': 'mock:drizzle-orm',
      '@openbooks/engine/src/db.ts': 'mock:db',
      '@openbooks/engine/src/business-date.ts': 'mock:business-date',
      '@openbooks/engine/src/money.ts': 'mock:money',
      '@openbooks/engine/src/payroll-cheques.ts': 'mock:payroll-cheques',
      '../money-format': 'mock:money-format',
      '../locale': 'mock:locale',
      './catalog': 'mock:catalog',
      '../field-tickets': 'mock:field-tickets',
    }
    const url = mocks[specifier]
    if (url) return { url, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { loadPdfRecordValues } = await import('./values.ts?us-ytd-tax-test')

test('US pay-stub YTD income tax includes federal FIT and preserves pay totals', async () => {
  const record = await loadPdfRecordValues('pay_stub', 'org-1', state.stub.id)

  assert.ok(record)
  assert.match(state.ytdQuery, /factors->>'FIT'/)
  assert.equal(record.values.ytd_tax, '$312.31')
  assert.equal(record.values.ytd_gross, '$4,000.00')
  assert.equal(record.values.ytd_net, '$3,281.69')
})
