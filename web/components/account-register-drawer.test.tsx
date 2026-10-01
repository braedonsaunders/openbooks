import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules'
import { bootJsdomEnvironment } from '../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'http://localhost/accounts?accountRegister=019f0000-0000-4000-8000-000000000003', matchMediaMatches: false })
stubModules({ navigation: { source: 'export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return globalThis.__registerRouter}' }, intl: false, authz: false, features: false })
const React = await import('react')
Object.assign(globalThis, { React, __registerRouter: { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} } })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { AccountRegisterDrawer } = await import('./account-register-drawer')

test('refreshing translations preserves the loaded register without invoking a translator as state', async (t) => {
  const prior = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    return Response.json({ account: { id: '019f0000-0000-4000-8000-000000000003', number: '1000', name: 'Bank', type: 'asset_bank' }, lines: [], page: 1, perPage: 50, total: 0, balance: '0.0000' })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  const render = async (currentMessages: typeof messages) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={currentMessages} timeZone="UTC"><MoneyProvider currency="CAD"><AccountRegisterDrawer /></MoneyProvider></NextIntlClientProvider>)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await render(messages)
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  await render({ ...messages })
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(requests, 1, 'changing translations does not discard financial rows or repeat a read')
})
