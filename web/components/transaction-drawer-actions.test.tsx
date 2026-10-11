import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "http://localhost/parties?party=11111111-1111-4111-8111-111111111111", matchMediaMatches: false })
stubModules({ navigation: { source: 'export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){},back(){},forward(){}}}' }, intl: false, authz: false, features: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { TransactionDrawer } = await import('./transaction-drawer')
const { Button } = await import('../../packages/ui/src/button')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const actionsLabel = (messages.common.labels as Record<string, string>).actions as string

async function pointerOnly(target: Element) {
  const opts = { bubbles: true, cancelable: true, button: 0 }
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('pointerdown', opts as MouseEventInit))
    target.dispatchEvent(new window.MouseEvent('pointerup', opts as MouseEventInit))
    await tick()
    await tick()
  })
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
}

async function renderDrawer(t: TestContext, actions: React.ReactNode) {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, { locale: 'en', messages, timeZone: 'UTC' },
        React.createElement(TransactionDrawer, {
          closeHref: '/parties', recordId: '11111111-1111-4111-8111-111111111111',
          title: 'Vendor', showEvidenceTabs: false,
          actions,
        }, React.createElement('div', null, 'body'))),
    )
    await tick()
    await tick()
  })
}

function actionsTrigger(): HTMLElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === actionsLabel) as HTMLElement | undefined
}

// A vendor record's Actions slot carries statement/payment entries behind
// per-grant conditionals; the shared trigger must open the menu for both
// pointer and keyboard activation, never silently eat the press.
test('record actions open on pointer release alone', async (t: TestContext) => {
  await renderDrawer(t, React.createElement(React.Fragment, null,
    null,
    React.createElement(Button, { variant: 'outline' }, 'View statement')))
  const trigger = actionsTrigger()
  assert.ok(trigger, 'the Actions button renders when an entry is visible')
  await pointerOnly(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'pointer release without a click must open the menu')
  const panel = document.querySelector('[data-ui-overlay]')
  assert.ok(panel?.textContent?.includes('View statement'), 'the menu carries the entry')
})

test('record actions still open on click', async (t: TestContext) => {
  await renderDrawer(t, React.createElement(React.Fragment, null,
    React.createElement(Button, { variant: 'outline' }, 'View statement')))
  const trigger = actionsTrigger()
  assert.ok(trigger, 'the Actions button renders when an entry is visible')
  await click(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'keyboard-equivalent click must open the menu')
  assert.ok(document.querySelector('[data-ui-overlay]'), 'the menu panel renders')
})
