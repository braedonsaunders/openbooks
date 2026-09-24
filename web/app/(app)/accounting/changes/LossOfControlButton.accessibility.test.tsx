import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/accounting/changes' })
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
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {push(){},refresh(){}}}' }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={error(){},success(){}}' }
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
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { LossOfControlButton } = await import('./LossOfControlButton')

test('loss-of-control selectors expose their field labels', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    interest: { investment_account_id: 'investment', equity_income_account_id: 'income' },
    subsidiaries: [{ id: 'sub-1', name: 'Subsidiary', base_currency: 'CAD' }],
    accounts: [{ id: 'account-1', number: '1000', name: 'Cash', type: 'asset' }],
    eliminations: [{ id: 'elim-1', name: 'Consolidation', base_currency: 'CAD' }],
    adjustmentLines: [{ id: 'line-1', entry_number: 'J-1', posting_date: '2026-09-01', account_name: 'Goodwill', amount: '10.00', memo: null }],
  })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-24">
          <LossOfControlButton interestId="interest-1" />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
  })
  const opener = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record loss of control'))
  assert.ok(opener)
  await act(async () => {
    opener.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => {
    for (const label of ['Add adjustment', 'Add reserve']) {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
      assert.ok(button, `${label} control renders`)
      button.click()
    }
  })
  const selectors = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
  assert.ok(selectors.length >= 5, 'account, entity, adjustment, and reserve selectors render')
  for (const selector of selectors) {
    assert.ok(selector.getAttribute('aria-label'), 'each SearchSelect trigger has an accessible name')
  }
  const selectorNames = selectors.map((selector) => selector.getAttribute('aria-label'))
  assert.ok(selectorNames.includes('Retained interest method'), 'retained-interest selector has a name')
  assert.ok(selectorNames.includes('Reserve treatment'), 'reserve-treatment selector has a name')
})
