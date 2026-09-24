import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-26: BulkEditDrawer closed silently on a half-typed adjustment — Cancel,
// the X button, Esc and the backdrop all dropped the typed component, amount
// and note with no question. The drawer now asks first when dirty (the
// confirmDiscard pattern: a clean drawer still closes without prompting, and
// declining keeps the drawer open with the typed work intact). Mounts the
// real drawer under jsdom and drives the close paths with a scripted confirm.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/runs/doc-1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const script = { confirmResult: false, confirmCalls: 0, closed: 0 }
Object.assign(globalThis, { __bulkDiscard: script })

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){const s=globalThis.__bulkDiscard;s.confirmCalls++;return s.confirmResult}',
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
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { BulkEditDrawer } = await import('./RunWizard')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const components = [
  { id: 'comp-bonus', name: 'Bonus', kind: 'earning' },
  { id: 'comp-tax', name: 'Extra tax', kind: 'deduction' },
] as unknown as Parameters<typeof BulkEditDrawer>[0]['components']

async function mount(t: TestContext): Promise<void> {
  script.confirmResult = false
  script.confirmCalls = 0
  script.closed = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BulkEditDrawer
          count={3}
          components={components}
          busy={false}
          onClose={() => {
            script.closed++
          }}
          onApply={async () => {}}
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

function amountInput(): HTMLInputElement {
  const input = document.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null
  assert.ok(input, 'the amount field must render')
  return input
}

function cancelButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Cancel',
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the Cancel button must render')
  return button
}

function closeButton(): HTMLButtonElement {
  const button = document.querySelector('button[aria-label="Close"]') as HTMLButtonElement | null
  assert.ok(button, 'the drawer X button must render')
  return button
}

async function typeAmount(value: string): Promise<void> {
  const input = amountInput()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
    await tick()
  })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 8; i++) await tick()
  })
}

test('a dirty drawer asks before closing and keeps the typed work on decline', async (t) => {
  await mount(t)
  await typeAmount('100')
  await click(cancelButton())
  assert.equal(script.confirmCalls, 1, 'closing a dirty drawer must ask first')
  assert.equal(script.closed, 0, 'declining the confirm must keep the drawer open')
  assert.equal(amountInput().value, '100', 'the typed amount must survive the declined close')
})

test('accepting the confirm closes the dirty drawer', async (t) => {
  await mount(t)
  await typeAmount('100')
  script.confirmResult = true
  await click(cancelButton())
  assert.equal(script.confirmCalls, 1, 'closing a dirty drawer must ask first')
  assert.equal(script.closed, 1, 'accepting the confirm must close the drawer')
})

test('a clean drawer closes without asking', async (t) => {
  await mount(t)
  await click(cancelButton())
  assert.equal(script.confirmCalls, 0, 'closing a clean drawer must not prompt')
  assert.equal(script.closed, 1, 'a clean drawer must close')
})

test('the X button asks too — every close path funnels through the guard', async (t) => {
  await mount(t)
  await typeAmount('100')
  await click(closeButton())
  assert.equal(script.confirmCalls, 1, 'the X button on a dirty drawer must ask first')
  assert.equal(script.closed, 0, 'declining the confirm must keep the drawer open')
})
