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

let confirmations = 0
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './confirm') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){globalThis.__dirtyConfirmCalls();return globalThis.__dirtyConfirmVerdict}',
      }
    }
    return next(specifier, context)
  },
})
Object.assign(globalThis, {
  __dirtyConfirmCalls: () => { confirmations += 1 },
  __dirtyConfirmVerdict: true,
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { useDirtyClose } = await import('./use-dirty-close')

test('dirty close waits for discard confirmation; clean close needs no confirmation', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let dirty = true
  let busy = false
  let childDirty = false
  let closes = 0
  function Harness() {
    const { close, registerDirty } = useDirtyClose({ dirty, busy, onClose: () => { closes += 1 }, message: 'Discard edits?', confirmLabel: 'Discard' })
    return <>
      <button onClick={() => void close()}>Close</button>
      <button onClick={() => { childDirty = !childDirty; registerDirty('child-draft', childDirty) }}>Toggle child edits</button>
    </>
  }
  const render = async () => act(async () => root.render(<Harness />))
  const clickClose = async () => act(async () => {
    host.querySelector('button')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const toggleChild = async () => act(async () => {
    host.querySelectorAll('button')[1]!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  await render()
  ;(globalThis as Record<string, unknown>).__dirtyConfirmVerdict = false
  await clickClose()
  assert.equal(closes, 0)
  assert.equal(confirmations, 1)

  ;(globalThis as Record<string, unknown>).__dirtyConfirmVerdict = true
  await clickClose()
  assert.equal(closes, 1)

  busy = true
  await render()
  await clickClose()
  assert.equal(closes, 1)
  assert.equal(confirmations, 2)

  busy = false
  dirty = false
  await render()
  await toggleChild()
  await clickClose()
  assert.equal(closes, 2, 'registered nested edits require confirmation')
  assert.equal(confirmations, 3)

  await toggleChild()
  await clickClose()
  assert.equal(closes, 3)
  assert.equal(confirmations, 3, 'cleared child edits need no confirmation')
})
