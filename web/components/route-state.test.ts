import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/missing-route' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof globals.ResizeObserver !== 'function') {
  globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { RouteStateView } = await import('./route-state')

test('a route refusal shows its title and explanation once beside the recovery action', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    dom.window.close()
  })

  await act(async () => {
    root.render(
      React.createElement(RouteStateView, {
        icon: React.createElement('span', null, '404'),
        title: 'Page not found',
        description: 'This route is unavailable.',
        state: 'not-found',
        action: React.createElement('a', { href: '/dashboard' }, 'Return to dashboard'),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })

  assert.equal(host.querySelector('[data-route-state="not-found"]')?.getAttribute('data-route-state'), 'not-found')
  assert.equal(host.querySelectorAll('h1').length, 1, 'the page header owns exactly one title')
  assert.equal(host.querySelector('h1')?.textContent, 'Page not found')
  assert.equal(host.querySelectorAll('h3').length, 0, 'the body empty state must not repeat the title')
  assert.equal([...host.querySelectorAll('p')].filter((p) => p.textContent === 'This route is unavailable.').length, 1)
  assert.equal(host.querySelector('a[href="/dashboard"]')?.textContent, 'Return to dashboard')
  assert.ok(host.textContent?.includes('404'), 'the title-less body still carries its status icon')
})
