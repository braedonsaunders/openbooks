import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/analytics', scrollIntoView: false, resizeObserver: false })

declare global {
  var __configRouter: { refresh(): void } | undefined
  var __configToasts: { kind: string; message: string }[] | undefined
}

globalThis.__configRouter = { refresh() {} }
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__configRouter}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return { shortCircuit: true, url: "data:text/javascript,export const toast={error(m){(globalThis.__configToasts??=[]).push({kind:'error',message:String(m)})}}" }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { ConfigEditor } = await import('./ConfigEditor')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('a rejected save request surfaces failure and releases the save button', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') throw new Error('network unavailable')
    return Response.json({
      fields: [{ key: 'duplicateDays', kind: 'number', labelKey: 'analytics.sentinel.config.fields.duplicateDays.label', helpKey: 'analytics.sentinel.config.fields.duplicateDays.help', min: 0, max: 20, step: 1 }],
      values: { duplicateDays: 10 },
      defaults: { duplicateDays: 5 },
      currency: 'EUR',
      revision: 4,
    })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = priorFetch
  })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConfigEditor dashboard="sentinel" canEdit />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  const input = host.querySelector('input[type="number"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, '11')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save configuration')
  assert.ok(save)
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  assert.equal(save.disabled, false, 'a failed network request must leave Save available for retry')
  assert.match(host.textContent ?? '', /Save failed/, 'the failure must be visible after the request rejects')
})
