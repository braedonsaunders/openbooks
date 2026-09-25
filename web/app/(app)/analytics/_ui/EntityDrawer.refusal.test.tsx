import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/analytics' })
const target = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) (globalThis as Record<string, unknown>)[key] = target[key]
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/analytics'}export function useSearchParams(){return new URLSearchParams()}" }
    }
    return nextResolve(specifier, context)
  },
})

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
    dom.window.close()
  }
})
