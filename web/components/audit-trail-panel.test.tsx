import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// The record audit endpoint answers a uniform 404 when the caller's role
// cannot read the record's history. That is not a transient failure: the tab
// must say the history is unavailable to the role and offer no retry, while
// a genuine server failure keeps its retry.
const script = { status: 404 }
Object.assign(globalThis, {
  __auditPanelRouter: { push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} },
})
await bootJsdomEnvironment({ url: 'http://localhost:4800/cash-sales' })
stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__auditPanelRouter}' }, intl: false, authz: false, features: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { AuditTrailPanel } = await import('./audit-trail-panel')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const requests: string[] = []

globalThis.fetch = (async (url: unknown) => {
  const href = String(url)
  requests.push(href)
  if (!href.startsWith('/api/audit/record')) throw new Error(`unexpected fetch ${href}`)
  if (script.status === 200) {
    return Response.json({ rows: [], total: 0, page: 1, perPage: 15, actions: [], recordType: 'cash_sale' })
  }
  if (script.status === 404) return Response.json({ error: 'not_found' }, { status: 404 })
  return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
}) as typeof fetch

async function mount(t: test.TestContext) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AuditTrailPanel table="documents" recordId="00000000-0000-4000-8000-00000000c001" />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  return host
}

const en = (messages as { common: { auditTrail: Record<string, string> } }).common.auditTrail

test('a no-access answer names the unavailable history without a retry', async (t) => {
  script.status = 404
  const host = await mount(t)
  assert.ok(host.textContent?.includes(en.unavailableTitle), host.textContent ?? '')
  assert.ok(!host.textContent?.includes(en.loadFailedDescription), 'never the try-again-shortly copy')
  const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === en.retry)
  assert.equal(retry, undefined, 'retrying cannot grant access, so no retry is offered')
})

test('a server failure keeps the load-failed body and its retry', async (t) => {
  script.status = 502
  const host = await mount(t)
  assert.ok(host.textContent?.includes(en.loadFailedDescription), host.textContent ?? '')
  const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === en.retry)
  assert.ok(retry, 'a transient failure offers the retry')
  script.status = 200
  const before = requests.length
  await act(async () => {
    retry!.click()
    await tick()
    await tick()
  })
  assert.ok(requests.length > before, 'retry re-requests the history')
  assert.ok(host.textContent?.includes(en.emptyTitle), host.textContent ?? '')
})
