import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/payroll/parallel-run' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof globals.ResizeObserver !== 'function') globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
if (typeof window.requestAnimationFrame !== 'function') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}" }
    }
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: "data:text/javascript,export default function Link(p){return React.createElement('a',p,p.children)}" }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { ParallelRunView } = await import('./ParallelRunView')

test('tolerance removal has a translated accessible name', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ParallelRunView
            registers={[]}
            runs={[]}
            comparisons={[]}
            tolerances={[{ kind: 'earning', slot: 'base', tolerance: '1.00', reason: 'rounding', id: 'tol-1' }]}
            slots={[]}
            canManage
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })
  const openButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Tolerances (1)'))
  assert.ok(openButton, 'tolerance drawer can be opened')
  await act(async () => openButton.click())
  assert.ok(document.querySelector('button[aria-label="Delete"]'), 'remove tolerance control has a translated name')
})
