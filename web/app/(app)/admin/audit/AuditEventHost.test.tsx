import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/admin/audit?action=update&page=3', matchMediaMatches: true })
const React = await import('react')
Object.assign(globalThis, { React, __auditReact: React, IS_REACT_ACT_ENVIRONMENT: true })
const subscribers = new Set<() => void>()
Object.assign(globalThis, {
  __auditSubscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn) },
})
const push = window.history.pushState.bind(window.history)
window.history.pushState = (...args) => { push(...args); for (const fn of subscribers) fn() }
const replace = window.history.replaceState.bind(window.history)
window.history.replaceState = (...args) => { replace(...args); for (const fn of subscribers) fn() }
window.addEventListener('popstate', () => { for (const fn of subscribers) fn() })
stubModules({ navigation: { source: `
  export function usePathname(){return '/admin/audit'}
  export function useSearchParams(){const q=globalThis.__auditReact.useSyncExternalStore(globalThis.__auditSubscribe,()=>window.location.search);return new URLSearchParams(q)}
  export function useRouter(){throw new Error('Audit event navigation must not reload its list')}
` } })
const { createRoot } = await import('react-dom/client')
const { act } = React
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { AuditEventHost } = await import('./AuditEventHost')
const { AuditRows } = await import('./AuditRows')
const { JsonValue } = await import('./AuditEventDrawer')
const id = '019f0000-0000-4000-8000-000000000011'
const otherId = '019f0000-0000-4000-8000-000000000012'
const event = { id, rowId: id, action: 'update', at: '2026-09-01T12:00:00Z', actorName: 'Audit operator', recordType: 'parties', requestId: null, changes: { amount: ['1.00', '2.00'] } }
const tick = () => new Promise((r) => setTimeout(r, 30))

test('audit event selection fetches only detail, handles refusals and ignores stale requests', async (t) => {
  const priorFetch = globalThis.fetch
  const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
  let resolveInitial: ((response: Response) => void) | undefined
  let resolveOther: ((response: Response) => void) | undefined
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), signal: options?.signal })
    if (String(url).endsWith(otherId)) return new Promise<Response>((resolve) => { resolveOther = resolve })
    if (calls.length === 1) return new Promise<Response>((resolve) => { resolveInitial = resolve })
    return Response.json(event)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const node = document.createElement('div')
  document.body.appendChild(node)
  const root = createRoot(node)
  t.after(async () => { await act(async () => root.unmount()); node.remove() })
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AuditRows rows={[{ ...event, summaryKind: 'fields', changeCount: 1 }]} />
      <AuditEventHost event={null} />
    </NextIntlClientProvider>)
  })
  assert.equal(calls.length, 0)
  await act(async () => { (node.querySelector('[role="link"]') as HTMLElement).click(); await tick() })
  assert.equal(window.location.search, `?action=update&page=3&event=${id}`)
  assert.deepEqual(calls.map((c) => c.url), [`/api/audit/events/${id}`])
  const loadingDialog = document.querySelector('[role="dialog"]')!
  assert.ok(loadingDialog)
  assert.ok(loadingDialog.querySelector('[aria-busy="true"]'))
  const closeButton = loadingDialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
  closeButton.focus()
  loadingDialog.scrollTop = 37
  await act(async () => { resolveInitial?.(Response.json(event)); await tick() })
  assert.ok(document.querySelector('[role="dialog"]') === loadingDialog, 'loading and success retain the same dialog')
  assert.ok(document.activeElement === closeButton, 'loading completion preserves focus')
  assert.equal(loadingDialog.scrollTop, 37, 'loading completion preserves scroll')
  assert.equal(document.body.style.overflow, 'hidden', 'the drawer retains its scroll lock')
  assert.ok(document.body.textContent?.includes('Audit operator'))
  assert.equal(node.querySelectorAll('tbody tr').length, 1, 'the existing list stays mounted')
  await act(async () => { window.history.pushState(null, '', `/admin/audit?action=update&page=3&event=${otherId}`); await tick() })
  assert.ok(document.querySelector('[aria-busy="true"]'), 'detail loading is immediately visible')
  await act(async () => { window.history.pushState(null, '', `/admin/audit?action=update&page=3&event=${id}`); await tick() })
  assert.equal(calls[1]?.signal?.aborted, true)
  await act(async () => { resolveOther?.(Response.json({ ...event, id: otherId, actorName: 'Stale response' })); await tick() })
  assert.ok(!document.body.textContent?.includes('Stale response'))
  globalThis.fetch = (async () => Response.json({ error: 'Unrestricted subsidiary access is required.' }, { status: 403 })) as typeof fetch
  await act(async () => { window.history.pushState(null, '', `/admin/audit?action=update&page=3&event=${otherId}`); await tick() })
  assert.ok(document.body.textContent?.includes('Unrestricted subsidiary access is required.'))
  const refusedDialog = document.querySelector('[role="dialog"]')
  globalThis.fetch = (async () => Response.json({ ...event, id: otherId })) as typeof fetch
  const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
  assert.ok(retry)
  await act(async () => { retry.click(); await tick() })
  assert.ok(document.querySelector('[role="dialog"]') === refusedDialog, 'retry keeps the same dialog through refusal and success')
  assert.ok(document.body.textContent?.includes('Audit operator'))
  assert.ok(!document.body.textContent?.includes('Unrestricted subsidiary access is required.'))
  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!
  await act(async () => { close.click(); await new Promise((resolve) => setTimeout(resolve, 600)) })
  assert.equal(window.location.search, '?action=update&page=3', 'the house close animation commits shallow navigation and preserves list filters')
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('snapshot collections render nested evidence only when expanded', async () => {
  const node = document.createElement('div')
  document.body.appendChild(node)
  const root = createRoot(node)
  try {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <JsonValue value={[{ description: 'Retained document line', nested: { exactAmount: '9007199254740993.1234' } }]} />
    </NextIntlClientProvider>))
    assert.ok(!node.textContent?.includes('9007199254740993.1234'))
    const details = node.querySelector('details')!
    await act(async () => { details.open = true; details.dispatchEvent(new window.Event('toggle')); await tick() })
    assert.ok(node.textContent?.includes('9007199254740993.1234'))
  } finally {
    await act(async () => root.unmount())
    node.remove()
  }
})
