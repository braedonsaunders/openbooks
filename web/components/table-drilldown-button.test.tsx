import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { TableDrilldownButton } = await import('./table-drilldown-button')

test('table drilldown has a native name and activates from its button', async (t) => {
  let activations = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(<table><tbody><tr><td><TableDrilldownButton onActivate={() => { activations += 1 }}>Ada Supplies</TableDrilldownButton></td></tr></tbody></table>)
  })

  const button = document.querySelector('button')
  assert.ok(button, 'a native button provides keyboard focus and activation')
  assert.equal(button.type, 'button')
  assert.equal(button.textContent, 'Ada Supplies', 'visible text supplies the accessible name')
  button.focus()
  assert.equal(document.activeElement, button, 'the drilldown can receive keyboard focus')
  await act(async () => button.click())
  assert.equal(activations, 1, 'activating the button invokes the drilldown')
})
