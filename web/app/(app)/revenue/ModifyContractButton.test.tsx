import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F1-8: the modify-contract form was hard-coded English and its save path
// parsed the mutation response with hard-coded English fallbacks. Mounts
// the real ModifyContractButton under jsdom, opens the form, and asserts
// the chrome renders through the catalog (en) and a failed proposal
// toasts the translated fallback with the status.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/revenue?contract=00000000-0000-0000-0000-000000000001',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const script = {
  errors: [] as string[],
}
Object.assign(globalThis, {
  __revenueTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__revenueTestRouter}export function usePathname(){return "/revenue"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__revenueErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { ModifyContractButton } = await import('./ModifyContractButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const payload = {
  contract: {
    id: '00000000-0000-0000-0000-000000000001',
    contract_number: 'C-001',
    subsidiary_id: '00000000-0000-0000-0000-000000000002',
    customer: 'Acme',
    status: 'active',
    currency: 'USD',
    total_transaction_price: '12000.00',
    starts_on: '2026-01-01',
    ends_on: '2026-12-31',
    sourceInvoiceId: null,
    sourceInvoiceNumber: null,
  },
  obligations: [],
} as unknown as Parameters<typeof ModifyContractButton>[0]['payload']

const options = {
  subsidiaries: [{ value: '00000000-0000-0000-0000-000000000002', label: 'HQ', currency: 'USD' }],
  books: [{ value: '00000000-0000-0000-0000-000000000003', label: 'Primary' }],
  rules: [{ value: '00000000-0000-0000-0000-000000000004', label: 'Straight-line', method: 'straight_line_even' }],
  accounts: [
    { value: '00000000-0000-0000-0000-000000000005', label: '4000 Deferred' },
    { value: '00000000-0000-0000-0000-000000000006', label: '5000 Revenue' },
  ],
} as unknown as Parameters<typeof ModifyContractButton>[0]['options']

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  ;(globalThis as Record<string, unknown>).__revenueErrorToasts = script.errors
  const prior = globalThis.fetch
  globalThis.fetch = (async () => responder()) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-01">
          <ModifyContractButton payload={payload} options={options} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
}

function clickByText(text: string): void {
  const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text)
  assert.ok(el, `a "${text}" button must render`)
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

async function openForm(): Promise<void> {
  await act(async () => {
    clickByText('Modify contract')
    for (let i = 0; i < 6; i++) await tick()
  })
}

test('the modify form chrome renders translated', async (t) => {
  await mount(t, () => Response.json({}))
  await openForm()
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Accounting group 1'), 'the group title must render')
  assert.ok(text.includes('Accounting treatment'), 'the treatment label must render')
  assert.ok(text.includes('Create approval proposal'), 'the propose action must render')
  assert.ok(
    !/modify\.[a-zA-Z]+/.test(text),
    'no untranslated key path may leak into the chrome',
  )
})

test('a failed proposal toasts the translated fallback with the status', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  await openForm()
  await act(async () => {
    clickByText('Create approval proposal')
    for (let i = 0; i < 6; i++) await tick()
  })
  assert.deepEqual(script.errors, ['Contract modification could not be proposed (status 502)'])
})
