import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-20 (purchasing): the empty commitments hero names its prerequisite and
// offers the create action only when the caller holds it; readers without
// creation access keep the honest zero with no misleading button.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/purchasing',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { CommitmentsSection } = await import('./sections')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountHero(
  t: TestContext,
  props: React.ComponentProps<typeof CommitmentsSection>,
): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(<CommitmentsSection {...props} />)
    await tick()
    await tick()
  })
}

const EMPTY = 'No open commitments or payables. Create a purchase order or record a vendor bill.'

test('the empty hero names the prerequisite with the granted action', async (t) => {
  await mountHero(t, {
    rows: [],
    showPurchaseOrders: true,
    empty: EMPTY,
    emptyAction: { href: '/purchase-orders?orderNew=1', label: 'New purchase order' },
  })
  const body = document.body.textContent ?? ''
  assert.match(body, /Create a purchase order or record a vendor bill/, 'the zero must name its prerequisite')
  const action = document.querySelector('a[href="/purchase-orders?orderNew=1"]')
  assert.ok(action, 'the granted create action must be offered')
  assert.match(action.textContent ?? '', /New purchase order/, 'the action must name its remedy')
})

test('readers without creation access keep the honest zero alone', async (t) => {
  await mountHero(t, { rows: [], showPurchaseOrders: true, empty: EMPTY, emptyAction: null })
  const body = document.body.textContent ?? ''
  assert.match(body, /Create a purchase order or record a vendor bill/, 'the prerequisite copy stays')
  assert.equal(document.querySelector('a'), null, 'no action may be offered without its grant')
})
