import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// The receipt review card: blank, highlighted fields for low-confidence
// readings, a suggestion the reviewer must accept, the currency refusal, and
// the line it hands to the drawer. Only the API boundary (fetch) is scripted.

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

async function mount(t: TestContext, captures: unknown[]) {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    captures,
    reportCurrency: 'CAD',
    canScan: true,
    captureOperational: true,
    canConfigure: false,
    configureHref: '/admin/ai',
  })) as typeof fetch
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

test('a receipt in another currency cannot be added and names the remedy', async (t) => {
  const { host } = await mount(t, [capture({
    issues: [{ code: 'currency_mismatch', severity: 'blocking', field: 'currency', actual: 'USD', expected: 'CAD' }],
    draft: {
      ...capture().draft,
      merchantName: field('Uber', 'Uber', '0.9900', false),
      currency: field('USD', 'USD', '0.9800', false),
      total: field(null, '24.1000', '0.9900', true),
      currencyMatchesReport: false,
    },
  })])
  assert.match(host.textContent ?? '', /This receipt is in USD but the report is in CAD/)
  const total = host.querySelector<HTMLInputElement>(`#${CSS.escape(`${CAPTURE_ID}-total`)}`)!
  assert.equal(total.value, '')
  await act(async () => { button(host, 'Use suggestion').click() })
  await act(async () => { setInput(total, '33.10') })
  assert.equal(button(host, 'Add to report').disabled, true)
})

test('a failed scan shows its reason with retry and discard', async (t) => {
  const { host } = await mount(t, [capture({ status: 'failed', draft: null, issues: [], lastError: 'Document provider submission failed: Invalid subscription key' })])
  assert.match(host.textContent ?? '', /Invalid subscription key/)
  assert.ok(button(host, 'Retry'))
  assert.ok(button(host, 'Discard'))
})
