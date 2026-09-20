import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { DrawerTabStrip } = await import('./drawer-tab-strip.tsx')

// The shared strip renders one level of tab buttons in house style: the rail
// and the payroll sub-tabs are the same primitive, not two tab looks.
test('the strip renders every tab with the active one selected', () => {
  const html = renderToStaticMarkup(
    <DrawerTabStrip
      tabs={[
        { key: 'general', label: 'General' },
        { key: 'tax', label: 'Tax and withholding' },
      ]}
      activeKey="tax"
      onSelect={() => {}}
      ariaLabel="Payroll sections"
    />,
  )
  assert.match(html, /<nav[^>]*aria-label="Payroll sections"/)
  assert.match(html, /role="tab"/)
  assert.match(html, />General</)
  assert.match(html, />Tax and withholding</)
  assert.match(html, /aria-selected="true"[^>]*>Tax and withholding</)
  assert.match(html, /aria-selected="false"[^>]*>General</)
})

// The behavioural contract, exercised for real: clicking a tab notifies the
// parent with that tab's key. A text pin on the caller's variable name
// cannot tell a rename from a broken callback; this can.
test('selecting a tab notifies the parent with the tab key', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  try {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const selected: string[] = []
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(
        <DrawerTabStrip
          tabs={[
            { key: 'general', label: 'General' },
            { key: 'tax', label: 'Tax and withholding' },
          ]}
          activeKey="general"
          onSelect={(key) => selected.push(key)}
          ariaLabel="Payroll sections"
        />,
      )
    })
    const tabs = [...dom.window.document.querySelectorAll('button[role="tab"]')]
    assert.equal(tabs.length, 2)
    await act(async () => {
      tabs[1]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(selected, ['tax'], 'the clicked tab key reaches the parent')
    await act(async () => {
      root.unmount()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    dom.window.close()
  }
})

