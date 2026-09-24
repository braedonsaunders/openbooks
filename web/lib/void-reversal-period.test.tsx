import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// The void-reversal choice is the only client surface for the A-S11
// adjustment-period override: it offers no choice when the org uses no
// adjustment periods, offers the regular default plus each named period
// otherwise, and never blocks the void on a failed lookup. These tests
// mount the real PromptRoot under jsdom with scripted fetches.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/journal',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
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
const messages = (await import('../messages/en')).default
const { PromptRoot } = await import('./prompt')
const { promptVoidReversalPeriod } = await import('./void-reversal-period')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const COPY = {
  title: 'Reverse into which period?',
  label: 'Reversal period',
  regularOption: 'Regular period (default)',
  confirm: 'Void',
  cancel: 'Cancel',
}

async function mountPromptRoot(t: TestContext): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PromptRoot />
      </NextIntlClientProvider>,
    )
    await tick()
  })
}

function scriptFetch(t: TestContext, handler: (url: string) => Response): void {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]')
}

async function chooseOption(value: string): Promise<void> {
  const select = document.querySelector('select#prompt-input') as HTMLSelectElement | null
  assert.ok(select, 'the period choice must render a select')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const form = select.closest('form')
  assert.ok(form, 'the choice must live in a form')
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await tick()
  })
}

async function clickCancel(): Promise<void> {
  const buttons = [...document.querySelectorAll('[role="dialog"] button')]
  const cancel = buttons.find((b) => (b.textContent ?? '').trim() === COPY.cancel)
  assert.ok(cancel, 'the choice must offer cancel')
  await act(async () => {
    ;(cancel as HTMLButtonElement).click()
    await tick()
  })
}

test('no adjustment periods means no choice and the regular default', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, (url) => {
    assert.match(url, /\/api\/documents\/.+\/void/)
    return Response.json({ adjustmentPeriods: [] })
  })
  const choice = await promptVoidReversalPeriod('doc-1', COPY)
  assert.deepEqual(choice, { cancelled: false, reversalPeriodId: null })
  assert.equal(dialog(), null)
})

test('adjustment periods are offered after the regular default', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
      { id: 'period-b', name: 'FY25 Adjustment', startsOn: '2025-07-01', endsOn: '2025-07-31' },
    ],
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await act(async () => {
    await tick()
    await tick()
  })
  const options = [...document.querySelectorAll('select#prompt-input option')]
  assert.deepEqual(
    options.map((o) => [(o as HTMLOptionElement).value, (o.textContent ?? '').trim()]),
    [
      ['', COPY.regularOption],
      ['period-a', 'FY26 Adjustment'],
      ['period-b', 'FY25 Adjustment'],
    ],
  )
  await chooseOption('period-b')
  assert.deepEqual(await pending, { cancelled: false, reversalPeriodId: 'period-b' })
})

test('choosing the regular default resolves a null override', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
    ],
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await act(async () => {
    await tick()
    await tick()
  })
  await chooseOption('')
  assert.deepEqual(await pending, { cancelled: false, reversalPeriodId: null })
})

test('dismissing the choice cancels the void', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => Response.json({
    adjustmentPeriods: [
      { id: 'period-a', name: 'FY26 Adjustment', startsOn: '2026-07-01', endsOn: '2026-07-31' },
    ],
  }))
  const pending = promptVoidReversalPeriod('doc-1', COPY)
  await act(async () => {
    await tick()
    await tick()
  })
  await clickCancel()
  assert.deepEqual(await pending, { cancelled: true, reversalPeriodId: null })
})

test('a failed period lookup falls back to the default without prompting', async (t) => {
  await mountPromptRoot(t)
  scriptFetch(t, () => new Response('proxy error', { status: 502 }))
  const choice = await promptVoidReversalPeriod('doc-1', COPY)
  assert.deepEqual(choice, { cancelled: false, reversalPeriodId: null })
  assert.equal(dialog(), null)
})
