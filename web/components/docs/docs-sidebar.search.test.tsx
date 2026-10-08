import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { stubModules } from '../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/docs', matchMediaMatches: false })
stubModules({ navigation: { pathname: '/docs/welcome' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const { docNavIndex } = await import('../../lib/docs')
const { DocsSidebar } = await import('./docs-sidebar')

test('documentation search finds article-body terms with metadata-only initial props', async () => {
  const metadata = docNavIndex({ includeText: false })
  assert.ok(metadata.articles.every(article => article.text === undefined))
  const term = 'configurable accounting and operations'
  assert.ok(metadata.articles.every(article => !JSON.stringify(article).toLowerCase().includes(term)))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><DocsSidebar {...metadata} /></NextIntlClientProvider>))
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, term)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.ok(host.querySelector('a[href="/docs/welcome"]'), 'body matches remain discoverable after the search chunk loads')
    assert.equal(host.querySelector('[role="status"]'), null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
