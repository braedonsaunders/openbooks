import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F2-9: the lease drawer was hard-coded English and parsed mutation
// responses before checking the status. Mounts the real LeaseDrawer under
// jsdom and asserts the summary chrome renders through the catalog (en)
// and a failed commence toasts the translated fallback with the status.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/assets/leases?lease=00000000-0000-0000-0000-000000000001',
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
  __leasesTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__leasesTestRouter}export function usePathname(){return "/assets/leases"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__leasesErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
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
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { LeaseDrawer } = await import('./LeaseDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const payload = {
  lease: {
    id: '00000000-0000-0000-0000-000000000001',
    lease_number: 'L-001',
    description: 'Head office',
    status: 'draft',
    subsidiary_id: '00000000-0000-0000-0000-000000000002',
    commencement_on: '2026-01-01',
    term_periods: 12,
    payment_frequency: 'monthly',
    payment_timing: 'arrears',
    payment_amount: '1000.00',
    annual_discount_rate_percent: '5.00',
    classification: 'operating',
    initial_liability: null,
    initial_rou_asset: null,
    revision: 1,
    classification_inputs: {},
  },
  schedule: [
    {
      id: '00000000-0000-0000-0000-000000000003',
      sequence: 1,
      revision: 1,
      due_on: '2026-01-31',
      period_end: '2026-01-31',
      payment: '1000.00',
      interest: '4.07',
      amortization: null,
      single_cost: null,
      payment_posted: false,
      accrual_posted: false,
      superseded: false,
    },
  ],
  changes: [],
} as unknown as Parameters<typeof LeaseDrawer>[0]['payload']

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  ;(globalThis as Record<string, unknown>).__leasesErrorToasts = script.errors
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
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <LeaseDrawer payload={payload} canManage accounts={[]} subsidiaries={[]} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
}

function clickByText(text: string): void {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent === text)
  assert.ok(el, `a "${text}" button must render`)
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

test('the lease summary chrome renders translated', async (t) => {
  await mount(t, () => Response.json({}))
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Payment and accrual history'), 'the schedule title must render')
  assert.ok(text.includes('Initial unpaid liability'), 'the liability label must render')
  assert.ok(text.includes('Not commenced'), 'the uncommenced fallback must render')
  assert.ok(text.includes('Commence lease'), 'the commence action must render')
  assert.ok(text.includes('Planned'), 'the schedule status must render')
  assert.ok(
    !/leases\.[a-zA-Z]+/.test(text),
    'no untranslated key path may leak into the chrome',
  )
})

test('a failed commence toasts the translated fallback with the status', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  await act(async () => {
    clickByText('Commence lease')
    for (let i = 0; i < 6; i++) await tick()
  })
  assert.deepEqual(script.errors, ['Lease action failed (status 502)'])
})
