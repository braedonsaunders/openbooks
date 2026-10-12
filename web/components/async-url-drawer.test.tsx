import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost:4800/inventory?item=item-17', matchMediaMatches: false })
stubModules({ navigation: true, intl: false, authz: false, features: false })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = {
  common: (await import('../messages/en/common.json', { with: { type: 'json' } })).default,
  ui: (await import('../messages/en/ui.json', { with: { type: 'json' } })).default,
}
const { DrawerNavigateContext } = await import('@openbooks/ui')
const { AsyncUrlDrawer } = await import('./async-url-drawer')
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function waitForDismissal() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (document.querySelector('[role="dialog"]') === null) return
    await act(async () => { await tick() })
  }
  assert.fail('the native URL dialog must finish its exit after authorized dismissal')
}

test('URL request phases retain one native shell, retry callback, close guard and scoped close destination', async t => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const navigations: string[] = []
  const navigate = (href: string) => { navigations.push(href) }
  let allowClose = false
  let retries = 0
  const beforeClose = () => allowClose
  const onRetry = () => { retries++ }
  const closeHref = '/inventory?inventoryView=movements&warehouse=MAIN'
  const overflow = document.body.style.overflow
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  async function render(phase: 'pending' | 'refused' | 'ready') {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DrawerNavigateContext.Provider value={navigate}>
          <AsyncUrlDrawer open openKey="item-17" title="Stock layers" closeHref={closeHref}
            pending={phase === 'pending'} error={phase === 'refused' ? 'The selected stock layers could not be read' : null}
            onRetry={onRetry} beforeClose={beforeClose}>
            <button type="button">Inspect retained layer</button>
          </AsyncUrlDrawer>
        </DrawerNavigateContext.Provider>
      </NextIntlClientProvider>)
      await tick()
    })
  }
  await render('pending')
  const shell = document.querySelector('[role="dialog"]')
  assert.ok(shell)
  const titleId = shell.getAttribute('aria-labelledby')
  assert.ok(titleId)
  assert.equal(document.getElementById(titleId)?.textContent, 'Stock layers')
  assert.ok(shell.querySelector('[aria-busy="true"]'))
  assert.equal(document.body.style.overflow, 'hidden')
  await render('refused')
  assert.ok(document.querySelector('[role="dialog"]') === shell, 'URL request phases must retain the same dialog element')
  assert.match(shell.textContent ?? '', /selected stock layers could not be read/)
  const retry = [...shell.querySelectorAll('button')].find(node => node.textContent === messages.common.actions.retry)
  assert.ok(retry)
  await act(async () => { retry.click(); await tick() })
  assert.equal(retries, 1)
  await render('pending')
  await render('ready')
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  assert.ok(document.querySelector('[role="dialog"]') === shell, 'URL request phases must retain the same dialog element')
  assert.equal(shell.getAttribute('aria-labelledby'), titleId)
  assert.match(shell.textContent ?? '', /Inspect retained layer/)
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
  assert.ok(document.querySelector('[role="dialog"]') === shell, 'the existing URL-host close guard still owns dismissal')
  assert.deepEqual(navigations, [])
  allowClose = true
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
  await waitForDismissal()
  assert.ok(document.querySelector('[role="dialog"]') === null, 'the authorized URL close must dismiss its dialog')
  assert.deepEqual(navigations, [closeHref])
  assert.equal(document.body.style.overflow, overflow)
})
