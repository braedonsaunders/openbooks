import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/dashboard' })
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
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){}}}' }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={error(){},success(){}}' }
    }
    if (specifier === './actions' && context.parentURL?.includes('_quick-actions-editor.tsx')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function listQuickActionOptions(){return {common:[],custom:[]}};export async function saveQuickActions(){return {ok:true}}' }
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
const messages = (await import('../../../messages/en')).default
const { QuickActionsEditor } = await import('./_quick-actions-editor')

test('quick action reorder and remove buttons use translated names', async (t) => {
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
        <QuickActionsEditor
          open
          value={[{ id: 'invoices', label: 'Invoices', href: '/ar/invoices', iconKey: 'file', tone: 'sky' }]}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.ok(document.querySelector('button[aria-label="Previous"]'), 'move up uses the translated previous name')
  assert.ok(document.querySelector('button[aria-label="Next"]'), 'move down uses the translated next name')
  assert.ok(document.querySelector('button[aria-label="Remove"]'), 'remove uses the translated remove name')
})

test('quick action icon and color choices expose human-readable names', async (t) => {
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
        <QuickActionsEditor
          open
          value={[{ id: 'invoices', label: 'Invoices', href: '/ar/invoices', iconKey: 'file', tone: 'sky' }]}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const edit = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Invoices'))
  assert.ok(edit, 'quick action can be edited')
  await act(async () => edit.click())
  assert.ok(document.querySelector('button[aria-label="Icon: Shield Alert"]'), 'icon name describes the selected glyph')
  assert.ok(document.querySelector('button[aria-label="Color: Rose"]'), 'color name describes the selected swatch')
  assert.equal(document.querySelector('button[aria-label="shield-alert"]'), null, 'raw icon ids are not exposed')
})
