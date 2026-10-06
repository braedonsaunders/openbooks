import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/analytics/financial-health?period=fy' })
stubModules({ navigation: 'export function useSearchParams(){return new URLSearchParams(window.location.search)}' })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { useAnalyticsTab } = await import('./use-analytics-tab')
const tabs = ['overview', 'items'] as const
type Props = { data: { label: string; _analyticsRead: { slug: string; tab: string; query: string; observedAt: string } } }
let selected: ReturnType<typeof useAnalyticsTab<Props, typeof tabs[number]>>
function Probe({ initial }: { initial: Props }) {
  // The probe exposes the hook's latest result to the assertions.
  // eslint-disable-next-line react-hooks/globals
  selected = useAnalyticsTab('financial-health', initial, tabs)
  return <div>{selected.loading ? 'loading' : selected.error ?? selected.props.data.label}</div>
}
function payload(label: string, tab: string, query: string, at: number): Props {
  return { data: { label, _analyticsRead: { slug: 'financial-health', tab, query, observedAt: new Date(at).toISOString() } } }
}
async function harness(t: TestContext) {
  const now = Date.now, originalFetch = globalThis.fetch
  const originalSet = window.setTimeout, originalClear = window.clearTimeout
  let clock = now(), nextTimer = 0
  const timers = new Map<number, () => void>()
  const requests: { url: string; signal: AbortSignal; resolve(value: Response): void }[] = []
  Date.now = () => clock
  window.setTimeout = ((callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id }) as typeof window.setTimeout
  window.clearTimeout = (id) => { timers.delete(id) }
  globalThis.fetch = ((url: string, options: RequestInit) => new Promise<Response>(resolve => requests.push({ url, signal: options.signal!, resolve }))) as typeof fetch
  window.history.replaceState(null, '', '/analytics/financial-health?period=fy')
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount()); host.remove()
    Date.now = now; globalThis.fetch = originalFetch
    window.setTimeout = originalSet; window.clearTimeout = originalClear
    assert.equal(timers.size, 0, 'unmount disposes the refresh timer')
  })
  const initial = payload('initial', 'overview', 'period=fy', clock)
  const render = () => act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages}><Probe initial={initial} /></NextIntlClientProvider>))
  await render()
  return { host, requests, render, now: () => clock, advance: async () => {
    clock += 30_001
    const callbacks = [...timers.values()]; timers.clear()
    await act(async () => { for (const callback of callbacks) callback() })
  } }
}

test('an open tab refreshes after expiry and retains its body while the next source read is pending', async t => {
  const h = await harness(t)
  assert.equal(h.requests.length, 0)
  await h.advance()
  assert.equal(h.requests.length, 1)
  assert.equal(h.host.textContent, 'initial')
  await act(async () => h.requests[0]!.resolve(Response.json(payload('refreshed', 'overview', 'period=fy', h.now()))))
  assert.equal(h.host.textContent, 'refreshed')
  assert.equal(h.requests.length, 1, 'resolution must not cause an immediate fetch loop')
})

test('changing the selected tab aborts its superseded read and ignores a late response', async t => {
  const h = await harness(t)
  await act(async () => selected.setTab('items')); await h.render()
  assert.equal(h.requests.length, 1)
  assert.equal(h.host.textContent, 'loading')
  await act(async () => selected.setTab('overview')); await h.render()
  assert.ok(h.requests[0]!.signal.aborted)
  await act(async () => h.requests[0]!.resolve(Response.json(payload('old items', 'items', 'period=fy', h.now()))))
  assert.equal(h.host.textContent, 'initial')
})

test('a source refusal is shown by name and retry opens one new request', async t => {
  const h = await harness(t)
  await act(async () => selected.setTab('items')); await h.render()
  await act(async () => h.requests[0]!.resolve(Response.json({ error: 'Configure the statement book before reading this period.' }, { status: 422 })))
  assert.equal(h.host.textContent, 'Configure the statement book before reading this period.')
  await act(async () => selected.retry())
  assert.equal(h.requests.length, 2)
  await act(async () => h.requests[1]!.resolve(Response.json(payload('items', 'items', 'period=fy', h.now()))))
  assert.equal(h.host.textContent, 'items')
})
