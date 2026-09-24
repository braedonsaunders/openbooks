import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/banking' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
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
const { AccountsRosterPanel } = await import('./AccountsRoster')
const { needsAttention } = await import('./view')

const day = (date: Date) => date.toISOString().slice(0, 10)
const ageInDays = 32
const today = new Date()
const staleDate = new Date(today.getTime() - ageInDays * 86_400_000)
const freshDate = new Date(today.getTime() - 3 * 86_400_000)

const accounts = [
  {
    id: 'bank-old', number: '1010', name: 'Operating account', type: 'asset_bank', currency: 'USD',
    balance: 1250, unmatched: 0, openReconciliationId: null, reconciledThrough: day(freshDate),
    lastStatementDate: day(staleDate), lastImportedAt: new Date().toISOString(), spark: [],
  },
  {
    id: 'bank-current', number: '1020', name: 'Reserve account', type: 'asset_bank', currency: 'USD',
    balance: 2500, unmatched: 0, openReconciliationId: null, reconciledThrough: day(freshDate),
    lastStatementDate: day(freshDate), lastImportedAt: null, spark: [],
  },
]

test('recent import does not make an old statement appear current in the roster or attention queue', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ layout: {}, revision: 'rev-1' })) as typeof fetch
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
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' } as unknown as React.ComponentProps<typeof NextIntlClientProvider>,
        React.createElement(
          MoneyProvider,
          { currency: 'USD' } as React.ComponentProps<typeof MoneyProvider>,
          React.createElement(AccountsRosterPanel, {
            accounts,
            totalCash: 3750,
            totalCards: 0,
            layoutPrefs: {},
          }),
        ),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  const oldRow = document.querySelector('a[href="/banking/bank-old"]')
  const currentRow = document.querySelector('a[href="/banking/bank-current"]')
  assert.match(oldRow?.textContent ?? '', new RegExp(`Last statement ${day(staleDate)}`))
  assert.doesNotMatch(oldRow?.textContent ?? '', /Statement \d{4}-\d{2}-\d{2} · USD/)
  assert.match(currentRow?.textContent ?? '', new RegExp(`Statement ${day(freshDate)}`))

  const attention = needsAttention(accounts as never, ((key: string, values?: Record<string, unknown>) =>
    `${key}:${String(values?.account ?? '')}:${String(values?.days ?? '')}`) as never)
  assert.deepEqual(attention, [{
    tone: 'warning',
    text: `home.attention.staleStatement:Operating account:${ageInDays}`,
    href: '/banking/bank-old',
  }])
})
