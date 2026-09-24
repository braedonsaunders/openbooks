import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/ap' })
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
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {push(){},replace(){},refresh(){}}}export function usePathname(){return "/ap"}export function useSearchParams(){return new URLSearchParams()}' }
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
const { ApCockpit } = await import('./ApCockpit')
const { CommitmentsTable } = await import('../../purchasing/CommitmentsTable')

test('vendor drilldown is a named keyboard-operable button inside its table cell', async (t) => {
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
          <ApCockpit
            canConfigure={false}
            canPay={false}
            data={{
              asOf: '2026-09-24', horizonWeeks: 13, outstanding: '10.00', overdue: '0.00', overdueCount: 0,
              dueThisWeek: '0.00', dueNext30: '0.00', dpo: 0,
              summary: { outstanding: '10.00', scheduled: '0.00', pctCurrent: '1.0000', avgDays: 0, buckets: [] },
              weeks: [], byVendor: [{ partyId: 'party-1', partyName: 'Ada Supplies', amount: '10.00', count: 1, overdue: '0.00', oldestDue: null }],
              worklist: [], payPlan: { weeklyCap: '0.00', restrictToSafe: false, scheduling: false, capacity: null, startingCash: '0.00', recommended: [], recommendedTotal: '0.00', deferredThisWeek: '0.00', deferredBeyondHorizon: '0.00' },
              categories: [], timeline: [],
            }}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })

  const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ada Supplies')
  assert.ok(action, 'vendor drilldown renders a button with the vendor name')
  assert.equal(action.type, 'button')
  assert.equal(action.closest('tr')?.onclick, null, 'the table row itself is not the pointer-only action')
})

test('purchasing vendor drilldown is a named button inside its table cell', async (t) => {
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
          <CommitmentsTable rows={[{
            partyId: 'party-1', name: 'Ada Supplies', openPoValue: 0, openPos: 0,
            openBills: 1, billedOpen: 10, overdue: 0, oldestDue: null,
          }]} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })
  const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ada Supplies')
  assert.ok(action, 'vendor name is a button with a text accessible name')
  assert.equal(action.closest('tr')?.onclick, null, 'the table row itself does not own the pointer-only action')
})
