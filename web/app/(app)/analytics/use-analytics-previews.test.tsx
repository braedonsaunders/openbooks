import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import type { AnalyticsPreview } from '../../../lib/analytics/dashboard-catalog'
await bootJsdomEnvironment()
const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { useAnalyticsPreviews } = await import('./use-analytics-previews')

type Read = { url: string; signal: AbortSignal; finish: (response: Response) => void }
const reads: Read[] = []
const originalFetch = globalThis.fetch
const preview: AnalyticsPreview = { metrics: [{ label: 'Count', value: '12' }], periodLabel: 'July', observedAt: '2026-07-31T12:00:00Z' }
const fetchReads: typeof fetch = (url, options) => new Promise<Response>((resolve) => reads.push({ url: String(url), signal: options!.signal!, finish: resolve }))
function Probe({ slugs, query = '' }: { slugs: string[]; query?: string }) {
  return <output>{JSON.stringify(useAnalyticsPreviews(slugs, query, 0, 'Load failed'))}</output>
}
async function mount(t: TestContext) {
  reads.length = 0; globalThis.fetch = fetchReads
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch })
  return { host, render: async (slugs: string[], query = '') => act(async () => { root.render(<Probe slugs={slugs} query={query} />) }) }
}

test('viewport additions keep existing reads alive and use at most four requests', async (t) => {
  const view = await mount(t)
  await view.render(['financial-health', 'allocations'])
  assert.equal(reads.length, 2)
  await view.render(['financial-health', 'allocations', 'asset-lifecycle', 'cashflow', 'receivables'])
  assert.equal(reads.length, 4)
  assert.ok(reads.every((read) => !read.signal.aborted))
  await act(async () => { reads[0]!.finish(Response.json(preview)) })
  assert.equal(reads.length, 5)
  assert.match(reads[4]!.url, /receivables/)
  assert.equal(JSON.parse(view.host.textContent!)['financial-health'].data.metrics[0].value, '12')
})

test('hidden queued cards do not start; changing period cancels old reads and rejects late results', async (t) => {
  const view = await mount(t)
  await view.render(['a', 'b', 'c', 'd', 'hidden'], 'period=fy')
  await view.render(['a', 'b', 'c', 'd'], 'period=fy')
  await act(async () => { reads[0]!.finish(Response.json(preview)) })
  assert.equal(reads.length, 4)
  const old = reads[1]!
  await view.render(['a'], 'period=last-year')
  assert.ok(old.signal.aborted)
  assert.equal(reads.length, 5)
  assert.match(reads[4]!.url, /period=last-year/)
  await act(async () => { old.finish(Response.json(preview)) })
  assert.equal(view.host.textContent, '{}')
  await act(async () => { reads[4]!.finish(Response.json(preview)) })
  assert.deepEqual(Object.keys(JSON.parse(view.host.textContent!)), ['a'])
})

test('a named refusal appears without trying to parse the success payload', async (t) => {
  const view = await mount(t)
  await view.render(['financial-health'])
  await act(async () => { reads[0]!.finish(Response.json({ error: 'Configure the statement book.' }, { status: 422 })) })
  assert.equal(JSON.parse(view.host.textContent!)['financial-health'].error, 'Configure the statement book.')
})

test('returning to an old visible card refreshes it without clearing its last calculated figures', async (t) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const now = Date.now
  let clock = now()
  Date.now = () => clock
  t.after(() => { Date.now = now })
  const view = await mount(t)
  await view.render(['financial-health'])
  await act(async () => { reads[0]!.finish(Response.json(preview)) })
  clock += 30_001
  await act(async () => { window.dispatchEvent(new window.Event('focus')) })
  assert.equal(reads.length, 2)
  assert.equal(JSON.parse(view.host.textContent!)['financial-health'].data.metrics[0].value, '12')
})
