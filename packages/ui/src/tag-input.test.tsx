import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// OM-17: TagInput mounted with an empty suggestion list (a ref-less
// stringArray field with an empty query — exactly the hrm-review-templates
// New drawer state) looped a render-phase setHighlight forever and crashed
// the page with React #301 "Too many re-renders". The highlight clamp must
// never update state during render, so an empty list mounts cleanly and the
// control stays usable for free entry.

// jsdom first: the control reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useTranslations(){return (k,o)=>o&&o.tag?\`remove \${o.tag}\`:k}`,
      }
    }
    if (specifier === 'lucide-react') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function X(){return null}',
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
const { TagInput } = await import('./tag-input')

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    async render() {
      await act(async () => {
        root.render(node)
        await tick()
      })
      await tick()
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** Controlled harness: the drawer owns the value, the control edits it. */
function Harness({ initial = [] as string[], options = [] as { value: string }[] }) {
  const [value, setValue] = React.useState<string[]>(initial)
  return React.createElement(TagInput, { value, onChange: setValue, options, ariaLabel: 'labels' })
}

function combobox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector('input[role="combobox"]')
  assert.ok(input instanceof HTMLInputElement, 'the tag combobox must render')
  return input
}

async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await tick()
}

test('an empty suggestion list mounts without a render-phase update loop (OM-17)', async () => {
  // Pre-fix this mount threw "Too many re-renders": with zero rows the
  // render-phase `setHighlight(0)` re-rendered forever (0 >= 0 stays true).
  const m = mount(React.createElement(Harness))
  await m.render()
  combobox(m.host)
  await m.unmount()
})

test('a list that filters down to zero rows stays mounted (OM-17)', async () => {
  // The same loop fired on update when a query matched nothing and free
  // entry was off: rowCount hit 0 while highlight stayed 0.
  const m = mount(
    React.createElement(TagInput, {
      value: [],
      onChange: () => {},
      options: [{ value: 'alpha' }],
      allowNew: false,
      ariaLabel: 'labels',
    }),
  )
  await m.render()
  await type(combobox(m.host), 'zzz-no-match')
  combobox(m.host)
  await m.unmount()
})

test('free entry adds and removes a label on an option-less control (OM-17)', async () => {
  // The ref-less ratingScaleLabels field has no options at all: typing a
  // label and pressing Enter must commit it, and the chip remove button
  // must take it back off.
  const m = mount(React.createElement(Harness))
  await m.render()
  const input = combobox(m.host)
  await type(input, 'Exceeds expectations')
  await press(input, 'Enter')
  const chip = m.host.querySelector('span span.truncate')
  assert.equal(chip?.textContent, 'Exceeds expectations', 'the committed label must render as a chip')
  const remove = m.host.querySelector('button[aria-label^="remove"]')
  assert.ok(remove instanceof HTMLButtonElement, 'the chip must offer a remove button')
  await act(async () => {
    remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await tick()
  assert.equal(m.host.querySelector('span span.truncate'), null, 'removing the chip must clear the value')
  await m.unmount()
})
