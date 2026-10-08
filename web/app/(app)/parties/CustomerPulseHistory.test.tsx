import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'
import type { CustomerPulseTimelinePage } from '../../../lib/customer-pulse-timeline-params'

await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics/receivables-intelligence?relatedParty=customer-1&relatedPartyRole=customer&period=thismonth&signal=severe', matchMediaMatches: false })
stubModules({
  navigation: { source:
    "export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){}}}" +
    "export function usePathname(){return window.location.pathname}" +
    "export function useSearchParams(){return new URLSearchParams(window.location.search)}" },
  intl: false, authz: false, features: false,
})
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('@/components/money-provider')
const { CustomerPulseHistory } = await import('./CustomerPulseHistory')
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const rows = (page: number) => Array.from({ length: 25 }, (_, index) => ({
  id: `invoice-${page}-${index}`, type: 'invoice' as const, title: `Invoice page ${page} row ${index}`,
  description: null, timestamp: '2026-07-15', amount: '10.0000', currency: 'CAD',
}))

test('history uses server pagination without changing drawer or host filters and retains the initial window', async (t) => {
  const initialPage: CustomerPulseTimelinePage = { rows: rows(1), page: 1, perPage: 25, total: 55, q: '', dir: 'desc' }
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    const url = new URL(String(input), window.location.origin)
    return Response.json({ ...initialPage, page: Number(url.searchParams.get('pulseHistoryPage')), rows: rows(2) })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  const render = () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="CAD"><CustomerPulseHistory partyId="customer-1" currency="CAD" initialPage={initialPage} withheld={false} /></MoneyProvider></NextIntlClientProvider>)
  await act(async () => { render(); await tick() })
  assert.equal(calls.length, 0, 'the snapshot already contains the first page; mounting must not fetch it twice')
  assert.equal(host.querySelectorAll('tbody tr').length, 25)
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')
  assert.ok(input)
  input.focus()
  const next = host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')
  assert.ok(next)
  await act(async () => { next.click(); render(); await tick(); await tick() })
  assert.equal(calls.length, 1)
  assert.equal(host.querySelector('input[type="search"]'), input, 'the search control remains mounted through loading')
  assert.equal(document.activeElement, input, 'paging does not remount or defocus the search control')
  assert.ok(calls[0]?.startsWith('/api/customers/customer-1/pulse/timeline?'), 'paging only reads history, not the financial snapshot')
  assert.equal(new URL(calls[0]!, window.location.origin).searchParams.get('pulseHistoryPage'), '2')
  const search = new URLSearchParams(window.location.search)
  assert.equal(search.get('relatedParty'), 'customer-1')
  assert.equal(search.get('relatedPartyRole'), 'customer')
  assert.equal(search.get('period'), 'thismonth')
  assert.equal(search.get('signal'), 'severe')
  assert.equal(search.get('pulseHistoryPage'), '2')
  assert.ok(host.textContent?.includes('Invoice page 2 row 24'))
  assert.ok(!host.textContent?.includes('Invoice page 1 row 0'))
})
