import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// The receipt review card: blank, highlighted fields for low-confidence
// readings, a suggestion the reviewer must accept, foreign-currency
// conversion, and the line it hands to the drawer. Only the API boundary
// (fetch) is scripted.

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/expenses/reports', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {push(){},refresh(){},replace(){},back(){},prefetch(){}}}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { ReceiptScanPanel } = await import('./ReceiptScanPanel')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const REPORT_ID = '019f0000-0000-4000-8000-0000000000aa'
const CAPTURE_ID = '019f0000-0000-4000-8000-0000000000bb'

function field(value: string | null, reading: string | null, confidence: string | null, needsReview: boolean) {
  return { value, reading, confidence, needsReview }
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    id: CAPTURE_ID,
    documentId: REPORT_ID,
    fileId: '019f0000-0000-4000-8000-0000000000cc',
    contentType: 'image/jpeg',
    originalFilename: 'keg.jpg',
    status: 'extracted',
    interrupted: false,
    attempts: 1,
    lastError: null,
    overallConfidence: '0.9500',
    normalized: null,
    issues: [{ code: 'low_confidence', severity: 'warning', field: 'merchantName', actual: '0.6200', expected: '0.8000' }],
    draft: {
      transactionDate: field('2026-10-03', '2026-10-03', '0.9600', false),
      merchantName: field(null, 'The Keg', '0.6200', true),
      merchantPartyId: null,
      currency: field('CAD', 'CAD', '0.9800', false),
      total: field('110.4900', '110.4900', '0.9800', false),
      taxAmount: field('10.9900', '10.9900', '0.9500', false),
      tip: field('15.0000', '15.0000', '0.9500', false),
      reportCurrency: 'CAD',
      currencyMatchesReport: true,
      suggestedAccount: { accountId: 'acct-meals', source: 'employee_history' },
    },
    merchantPartyName: null,
    confirmed: null,
    createdAt: '2026-10-17T12:00:00Z',
    ...overrides,
  }
}

const usdQuote = {
  reportCurrency: 'CAD',
  minorUnits: 2,
  allowRateOverride: false,
  quote: { rate: '1.3650000000', rateType: 'spot', observationDate: '2026-10-02', source: 'manual' },
  refusal: null,
}

async function mount(
  t: TestContext,
  captures: unknown[],
  fxRequests: string[] = [],
  report: { attachments?: unknown[]; canScan?: boolean; captureOperational?: boolean } = {},
) {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith('/api/file-cabinet/attachments')) return Response.json({ attachments: report.attachments ?? [] })
    if (url.startsWith('/api/expenses/fx-rate')) {
      fxRequests.push(url)
      return Response.json(usdQuote)
    }
    return Response.json({
      captures,
      reportCurrency: 'CAD',
      canScan: report.canScan ?? true,
      captureOperational: report.captureOperational ?? true,
      canConfigure: false,
      configureHref: '/admin/ai',
    })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const added: Array<{ captureId: string; line: Record<string, unknown>; facts: Record<string, unknown> }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => { root.unmount() })
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ReceiptScanPanel
            documentId={REPORT_ID}
            canAdd
            accounts={[{ value: 'acct-meals', label: '6100 Meals' }, { value: 'acct-travel', label: '6200 Travel' }]}
            taxProfiles={[{ value: 'code:hst', label: 'HST' }]}
            pendingCaptureIds={new Set()}
            refreshKey=""
            onAddLine={(captureId, line, facts) => added.push({ captureId, line: { ...line }, facts: { ...facts } })}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, added }
}

function setInput(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

/** The shared Select proxies a hidden native select beside its trigger. */
function pickOption(host: HTMLElement, triggerId: string, value: string) {
  const select = host.querySelector(`#${CSS.escape(triggerId)}`)!.closest('span')!.querySelector('select')!
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)
  assert.ok(found, `button ${label} must render`)
  return found as HTMLButtonElement
}

test('a low-confidence merchant stays blank and highlighted until the reviewer supplies it', async (t) => {
  const { host } = await mount(t, [capture()])
  const merchant = host.querySelector<HTMLInputElement>(`#${CSS.escape(`${CAPTURE_ID}-merchant`)}`)!
  assert.equal(merchant.value, '')
  assert.match(merchant.className, /ring-amber/)
  assert.match(host.textContent ?? '', /Receipt reads The Keg \(62% confident\)/)
  assert.match(host.textContent ?? '', /Merchant was read with low confidence\. Confirm it\./)
  // The account suggestion is offered, never applied: Add stays disabled.
  assert.match(host.textContent ?? '', /Suggested from this employee's last receipt here: 6100 Meals/)
  assert.equal(button(host, 'Add to report').disabled, true)
})

test('accepting the reading and suggestion adds a taxed line that splits the total', async (t) => {
  const { host, added } = await mount(t, [capture()])
  await act(async () => { button(host, 'Use').click() })
  await act(async () => { button(host, 'Use suggestion').click() })
  await act(async () => { pickOption(host, `${CAPTURE_ID}-tax-code`, 'code:hst') })
  const add = button(host, 'Add to report')
  assert.equal(add.disabled, false)
  await act(async () => { add.click() })
  assert.deepEqual(added, [{
    captureId: CAPTURE_ID,
    line: {
      accountId: 'acct-meals',
      description: 'The Keg · 2026-10-03',
      taxProfileId: 'code:hst',
      amount: '99.5000',
      taxOverridden: true,
      taxAmount: '10.9900',
      settlementType: 'out_of_pocket',
      foreign: null,
    },
    facts: { transactionDate: '2026-10-03', merchantName: 'The Keg', merchantPartyId: null },
  }])
})

test('without a tax code the whole receipt total is the line amount', async (t) => {
  const { host, added } = await mount(t, [capture()])
  await act(async () => { button(host, 'Use').click() })
  await act(async () => { button(host, 'Use suggestion').click() })
  await act(async () => { button(host, 'Add to report').click() })
  assert.equal(added[0]?.line.amount, '110.4900')
  assert.equal(added[0]?.line.taxOverridden, false)
  assert.equal(added[0]?.line.taxAmount, '')
})

function usdCapture() {
  return capture({
    issues: [{ code: 'foreign_currency', severity: 'warning', field: 'currency', actual: 'USD', expected: 'CAD' }],
    draft: {
      ...capture().draft,
      merchantName: field('Uber', 'Uber', '0.9900', false),
      currency: field('USD', 'USD', '0.9800', false),
      total: field('24.1000', '24.1000', '0.9900', false),
      taxAmount: field(null, null, null, false),
      currencyMatchesReport: false,
    },
  })
}

test('a receipt in another currency converts at the dated rate into the report currency', async (t) => {
  const fxRequests: string[] = []
  const { host, added } = await mount(t, [usdCapture()], fxRequests)
  assert.match(host.textContent ?? '', /This receipt is in USD\. Its line converts into CAD at the dated exchange rate/)
  assert.match(host.textContent ?? '', /Spent in USD, converted into CAD/)
  const total = host.querySelector<HTMLInputElement>(`#${CSS.escape(`${CAPTURE_ID}-total`)}`)!
  assert.equal(total.value, '24.10', 'the receipt total stays in its own currency')
  await act(async () => { await tick() })
  assert.ok(fxRequests.some((url) => url.includes('currency=USD') && url.includes('date=2026-10-03') && url.includes(`reportId=${REPORT_ID}`)),
    'the dated rate is read for the receipt date and this report')
  assert.match(host.textContent ?? '', /Converts to CA\$32\.90 at 1 USD = 1\.3650000000 CAD\./)
  await act(async () => { button(host, 'Use suggestion').click() })
  await act(async () => { button(host, 'Add to report').click() })
  assert.equal(added.length, 1)
  assert.equal(added[0]!.line.amount, '32.9000')
  const foreign = added[0]!.line.foreign as { state: Record<string, unknown>; original: Record<string, unknown> }
  assert.deepEqual(foreign.original, { amount: '24.1000', taxAmount: null })
  assert.equal(foreign.state.currency, 'USD')
  assert.equal(foreign.state.method, 'rate_table')
  assert.equal(foreign.state.rateDate, '2026-10-03')
  assert.equal(foreign.state.quotedRate, '1.3650000000')
})

test('a card statement amount in the report currency becomes the line exactly', async (t) => {
  const { host, added } = await mount(t, [usdCapture()])
  await act(async () => { await tick() })
  await act(async () => { pickOption(host, `${CAPTURE_ID}-fx-method`, 'billed_amount') })
  const billed = host.querySelector<HTMLInputElement>(`#${CSS.escape(`${CAPTURE_ID}-fx-billed`)}`)!
  await act(async () => { setInput(billed, '33.10') })
  assert.match(host.textContent ?? '', /Converts to CA\$33\.10 at 1 USD = 1\.3734439834 CAD\./, 'the rate is derived from the billed amount')
  await act(async () => { button(host, 'Use suggestion').click() })
  await act(async () => { button(host, 'Add to report').click() })
  assert.equal(added[0]!.line.amount, '33.1000')
  assert.equal((added[0]!.line.foreign as { state: { billedAmount: string } }).state.billedAmount, '33.10')
})

test('conflicting currency readings block the line until the reviewer settles the currency', async (t) => {
  const { host } = await mount(t, [capture({
    issues: [{ code: 'currency_conflict', severity: 'blocking', field: 'currency', actual: 'CAD, USD' }],
    draft: { ...capture().draft, merchantName: field('Uber', 'Uber', '0.9900', false), currency: field(null, null, null, true), currencyMatchesReport: null },
  })])
  assert.match(host.textContent ?? '', /different currencies \(CAD, USD\)/)
  await act(async () => { button(host, 'Use suggestion').click() })
  assert.equal(button(host, 'Add to report').disabled, true)
})

test('a failed scan shows its reason with retry and discard', async (t) => {
  const { host } = await mount(t, [capture({ status: 'failed', draft: null, issues: [], lastError: 'Document provider submission failed: Invalid subscription key' })])
  assert.match(host.textContent ?? '', /Invalid subscription key/)
  assert.ok(button(host, 'Retry'))
  assert.ok(button(host, 'Discard'))
})

test('an imported report lists its receipt files and no scanning setup notice', async (t) => {
  const { host } = await mount(t, [], [], {
    canScan: false,
    captureOperational: false,
    attachments: [{
      id: '019f0000-0000-4000-8000-0000000000dd',
      name: 'Sirius_Radio_113.53.png',
      fileType: 'image',
      contentType: 'image/png',
      sizeBytes: 37782,
      createdAt: '2026-10-21T17:37:22Z',
      createdBy: null,
      attachmentId: '019f0000-0000-4000-8000-0000000000ee',
    }],
  })
  const text = host.textContent ?? ''
  assert.ok(text.includes('Receipt files'), 'receipt files are presented under their own heading')
  assert.ok(text.includes('Sirius_Radio_113.53.png'), 'the imported receipt is listed')
  assert.ok(!text.includes('document capture provider'), 'no scanning setup notice where scanning is not offered')
  assert.ok(!text.includes('No receipts scanned yet'), 'an imported receipt is not reported as missing')
})

test('a scanned receipt is shown once, by its capture card', async (t) => {
  const scanned = capture()
  const { host } = await mount(t, [scanned], [], {
    attachments: [{
      id: scanned.fileId,
      name: 'keg.jpg',
      fileType: 'image',
      contentType: 'image/jpeg',
      sizeBytes: 1000,
      createdAt: '2026-10-17T12:00:00Z',
      createdBy: null,
      attachmentId: '019f0000-0000-4000-8000-0000000000ff',
    }],
  })
  const text = host.textContent ?? ''
  assert.equal(text.split('keg.jpg').length - 1, 1, 'the capture file is not listed again among receipt files')
})
