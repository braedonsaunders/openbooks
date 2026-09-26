import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics', scrollIntoView: false, resizeObserver: false })

const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: { pathname: '/analytics' } })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('../../../../components/money-provider')
const messages = (await import('../../../../messages/en')).default
const { EntityDrawer } = await import('./EntityDrawer')

test('cash entity drawer presents a named API refusal', async () => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(
    { error: 'Rate coverage is missing for Branch.' },
    { status: 422 },
  )) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <EntityDrawer party="party-1" name="Branch vendor" side="ap" onClose={() => {}} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      )
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Rate coverage is missing for Branch.')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
    window.close()
  }
})
