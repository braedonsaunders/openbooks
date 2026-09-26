import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "about:blank" });

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
