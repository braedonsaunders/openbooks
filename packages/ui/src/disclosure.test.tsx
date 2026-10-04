import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'Event', 'MouseEvent', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'lucide-react') {
      return { shortCircuit: true, url: 'data:text/javascript,export function ChevronRight(){return null}' }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { DisclosureSection } = await import('./disclosure')
type Props = import('./disclosure').DisclosureSectionProps

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  return {
    host,
    button: () => host.querySelector('button') as HTMLButtonElement,
    panel: () => host.querySelector('[id]') as HTMLElement,
    async click() { await act(async () => { this.button().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }) },
    async unmount() { await act(async () => { root.unmount() }); host.remove() },
  }
}

test('advanced depth starts collapsed, summarizes itself, and opens on demand', async () => {
  const view = await mount(React.createElement(DisclosureSection, { title: 'Advanced', summary: 'Per-order posting' } as Props, 'hidden settings'))
  assert.equal(view.button().getAttribute('aria-expanded'), 'false')
  assert.equal(view.panel().hidden, true)
  assert.match(view.host.textContent ?? '', /Per-order posting/)
  await view.click()
  assert.equal(view.button().getAttribute('aria-expanded'), 'true')
  assert.equal(view.panel().hidden, false)
  assert.doesNotMatch(view.button().textContent ?? '', /Per-order posting/, 'the summary is replaced by the settings themselves once open')
  await view.unmount()
})

test('content that needs attention cannot hide behind a collapsed heading', async () => {
  const view = await mount(React.createElement(DisclosureSection, { title: 'Advanced', forceOpen: true } as Props, 'unmapped value'))
  assert.equal(view.panel().hidden, false)
  await view.click()
  assert.equal(view.panel().hidden, false, 'a forced-open section ignores the toggle')
  await view.unmount()
})
