import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/analytics' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof globals.ResizeObserver !== 'function') globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}export function usePathname(){return '/analytics'}export function useSearchParams(){return new URLSearchParams()}" }
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
const { CashWeekFlyout } = await import('./CashWeekFlyout')

test('cash week pagination controls have translated accessible names', async (t) => {
  const entries = Array.from({ length: 26 }, (_, index) => ({
    id: `entry-${index}`,
    entryId: `entry-${index}`,
    docKind: 'vendor_bill',
    docNumber: `B-${index}`,
    docId: `doc-${index}`,
    partyId: `party-${index}`,
    partyName: `Vendor ${index}`,
    amount: '10.0000',
    tranDate: '2026-08-01',
    dueDate: null,
    predictedDate: '2026-08-03',
    weekStart: '2026-08-02',
    daysOverdue: 0,
    method: 'manual',
  }))
  const week = {
    weekStart: '2026-08-02', weekEnd: '2026-08-08', label: 'Aug 2–8',
    inflow: '0.0000', outflow: '260.0000', net: '-260.0000', startingCash: '1000.0000', endingCash: '740.0000',
    arEntries: [], apEntries: entries, arTotal: '0.0000', apTotal: '260.0000', arCount: 0, apCount: 26,
    dynamicInflow: '0.0000', dynamicOutflow: '0.0000', deferredOut: '0.0000', apCapacity: null,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <CashWeekFlyout week={week as never} categories={[]} onClose={() => {}} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.ok(document.querySelector('button[aria-label="Previous"]'), 'previous page control is named')
  assert.ok(document.querySelector('button[aria-label="Next"]'), 'next page control is named')
})
