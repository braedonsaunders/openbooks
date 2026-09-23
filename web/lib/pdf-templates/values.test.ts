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
  ytdValues: [] as unknown[],
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

const flattenValues = (values: unknown[]): unknown[] =>
  values.flatMap((v) =>
    v !== null && typeof v === 'object' && 'values' in (v as Record<string, unknown>)
      ? flattenValues((v as { values: unknown[] }).values ?? [])
      : [v],
  )

const harness = {
  async execute(query: { text?: string; values?: unknown[] }) {
    const text = String(query.text ?? '')
    state.ytdValues = flattenValues(query.values ?? [])
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
      // YTD income tax aggregates the persisted income-tax component lines
      // (never an enumerated factor list): without the lines join the stub's
      // federal withholding reads as 0.
      const tax = text.includes('pay_stub_lines') && text.includes('system_key') ? '312.3100' : '0'
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
      sql.join = (parts, sep) => ({
        text: parts.map((p) => (p && p.text) ?? '?').join((sep && sep.text) ?? ','),
        values: parts.flatMap((p) => (p && p.values) ?? [p]),
      })
    `,
  ],
  [
    'mock:packs',
    `
      // The registry derivation, stood in: the old five keys plus one novel
      // pack key. The assertions below prove values.ts interpolates THIS
      // list — a literal in values.ts could never produce payg_withholding.
      export function incomeTaxWithholdingSystemKeys() {
        return ['fit', 'income_tax', 'local_income_tax', 'payg_withholding', 'qc_income_tax', 'state_income_tax']
      }
    `,
  ],
  [
    'mock:db',
    `
      const harness = globalThis[Symbol.for('openbooks.pay-stub-values-test')]
      export const db = { execute: (query) => harness.execute(query) }
      // lib/subsidiaries (the shared scope predicate values.ts reuses) imports
      // this seam; the pay-stub path under test never reaches it.
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export function ambientTenantOrgId() { return null }
    `,
  ],
  [
    // Star re-export of the real pure date helpers (addCalendarDays, which
    // values.ts uses for field-ticket day iteration): pure date math with
    // nothing to isolate, so a hand copy could only drift. businessToday
    // stays pinned — the explicit export shadows the re-exported one.
    'mock:business-date',
    `export * from "@openbooks/engine/src/platform/business-date.ts"
      export async function businessToday() { return '2026-07-22' }`,
  ],
  // '@openbooks/engine/src/money/money.ts' is deliberately NOT mocked: a
  // hand double of the money kernel decides amounts with floats the real
  // kernel refuses on principle, so the assertions below used to pin
  // float-shaped behavior. The real bigint kernel loads through tsx.
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
    // The business-date double re-exports the real module, so its own star
    // import must resolve past this hook to the real file instead of looping
    // back into the mock. Re-based to this file so the workspace alias
    // resolves through node_modules like any other real import.
    if (context.parentURL?.startsWith('mock:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    const mocks: Record<string, string> = {
      'server-only': 'mock:server-only',
      'drizzle-orm': 'mock:drizzle-orm',
      '@openbooks/engine/src/platform/db.ts': 'mock:db',
      '@openbooks/engine/src/payroll/packs.ts': 'mock:packs',
      '@openbooks/engine/src/platform/business-date.ts': 'mock:business-date',
      '@openbooks/engine/src/payroll/cheques.ts': 'mock:payroll-cheques',
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

const valuesUrl = new URL('./values.ts?us-ytd-tax-test', import.meta.url).href
const { loadPdfRecordValues } = (await import(valuesUrl)) as typeof import('./values.ts')

test('US pay-stub YTD income tax aggregates persisted income-tax lines and preserves pay totals', async () => {
  const record = await loadPdfRecordValues('pay_stub', 'org-1', state.stub.id, null)

  assert.ok(record)
  // The YTD subquery joins the persisted lines and binds the registry-derived
  // component set — never a literal key list, never factor names.
  assert.match(state.ytdQuery, /pay_stub_lines/)
  assert.match(state.ytdQuery, /system_key/)
  for (const key of ['fit', 'income_tax', 'qc_income_tax', 'state_income_tax', 'local_income_tax']) {
    assert.ok(state.ytdValues.includes(key), `YTD tax counts ${key}`)
  }
  // payg_withholding comes from the derivation mock, not from any literal in
  // values.ts: its presence proves the query interpolates the helper's list.
  assert.ok(state.ytdValues.includes('payg_withholding'), 'YTD tax counts the derived pack key')
  assert.doesNotMatch(state.ytdQuery, /factors->>/)
  assert.equal(record.values.ytd_tax, '$312.31')
  assert.equal(record.values.ytd_gross, '$4,000.00')
  assert.equal(record.values.ytd_net, '$3,281.69')
})
