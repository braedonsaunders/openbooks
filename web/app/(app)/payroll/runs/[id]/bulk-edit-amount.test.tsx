import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F3-5: the bulk-edit amount used a naive two-decimal regex with Apply
// silently disabled — a decimal-comma operator met a dead button with no
// reason, and a four-decimal server-valid amount could never be entered.
// The drawer now reads through the shared money input: every unreadable
// value names its cause and remedy under the field. Mounts the real drawer
// under jsdom and drives the amount paths.
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

async function mount(t: TestContext, applied: Record<string, unknown>[]): Promise<void> {
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
          onClose={() => {}}
          onApply={async (body) => {
            applied.push(body)
          }}
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

function applyButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Apply to'),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the Apply button must render')
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

test('a decimal comma names the dotted rewrite and keeps Apply disabled', async (t) => {
  await mount(t, [])
  await typeAmount('12,34')
  assert.match(
    document.body.textContent ?? '',
    /must use "\." as the decimal point — write "12,34" as "12\.34"/,
    'the refusal must name the remedy, not a dead button',
  )
  assert.ok(applyButton().disabled, 'Apply must stay disabled on an unreadable amount')
})

test('a server-valid four-decimal amount enables Apply and posts it', async (t) => {
  const applied: Record<string, unknown>[] = []
  await mount(t, applied)
  const select = document.querySelector('select[aria-label="Component"]') as HTMLSelectElement | null
  assert.ok(select, 'the component picker must render')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, 'comp-bonus')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    await tick()
  })
  await typeAmount('1234.5678')
  assert.ok(!applyButton().disabled, 'a four-decimal amount the server reads must enable Apply')
  await click(applyButton())
  assert.equal(applied.length, 1)
  assert.equal(applied[0]!['amount'], '1234.5678')
})
