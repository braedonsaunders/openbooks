import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/analytics' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

declare global {
  var __configRouter: { refresh(): void } | undefined
  var __configToasts: { kind: string; message: string }[] | undefined
}

globalThis.__configRouter = { refresh() {} }
globalThis.__configToasts = []
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return globalThis.__configRouter}' }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: "data:text/javascript,export const toast={error(m){(globalThis.__configToasts??=[]).push({kind:'error',message:String(m)})}}" }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { ConfigEditor } = await import('./ConfigEditor')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('a rejected save request surfaces failure and releases the save button', async (t) => {
  const priorFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') throw new Error('network unavailable')
    return Response.json({ revision: 4 })
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
      <ConfigEditor
        dashboard="sentinel"
        fields={[{ key: 'weeklyApCap', label: 'Weekly cap', help: 'Limit', min: 0, max: 20, step: 1 }]}
        values={{ weeklyApCap: 10 }}
        defaults={{ weeklyApCap: 5 }}
      />,
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
