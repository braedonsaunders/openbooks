import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ComponentType, ReactNode } from 'react'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "http://localhost/", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__createMenuRouter}' }, intl: false, authz: false, features: false });

const React = await import('react')
Object.assign(globalThis, { React, __createMenuRouter: { pushes: [] as string[], push(url: string) { this.pushes.push(url) }, refresh() {} } })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const menuMessages = messages.shell.globalCreate
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string
  messages: typeof messages
  timeZone: string
  children?: ReactNode
}>
const { GlobalCreateMenu } = await import('./global-create-menu')

const permissions = {
  accountsReceivable: true,
  accountsPayable: true,
  journal: true,
  customerPayments: true,
  vendorPayments: true,
  expenses: true,
  parties: true,
  items: true,
  projects: true,
  assets: true,
  orders: true,
}
const destinations = new Map([
  ['Item', '/items?item=new'],
  ['Asset', '/assets?assetNew=1'],
  ['Customer', '/entities/customers?partyNew=1&role=customer'],
  ['Vendor', '/entities/vendors?partyNew=1&role=vendor'],
  ['Employee', '/entities/employees?partyNew=1&role=employee'],
  ['Project', '/projects?projectNew=1'],
])
const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
}

test('master-data choices navigate to their unsaved editor without creating drafts', async (t: TestContext) => {
  const router = (globalThis as Record<string, unknown>).__createMenuRouter as { pushes: string[] }
  router.pushes.length = 0
  const priorFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches += 1
    return Response.json({ id: 'unexpected-draft' })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages, timeZone: 'UTC' },
        React.createElement(GlobalCreateMenu, { permissions }),
      ),
    )
  })

  const trigger = document.querySelector(`button[aria-label="${menuMessages.ariaLabel}"]`)
  assert.ok(trigger, 'the global create control is available')
  for (const [label, href] of destinations) {
    if (document.querySelector(`button[aria-label="${menuMessages.ariaLabel}"]`)?.getAttribute('aria-expanded') !== 'true') {
      await click(trigger)
    }
    const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === menuMessages.items[label.toLowerCase() as keyof typeof menuMessages.items])
    assert.ok(action, `${label} is an available master-data choice`)
    await click(action)
    assert.equal(router.pushes.at(-1), href, `${label} opens the unsaved editor`)
  }
  assert.equal(fetches, 0, 'master-data navigation must not allocate a draft record')
})
