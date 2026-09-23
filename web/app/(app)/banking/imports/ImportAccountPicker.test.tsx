import assert from 'node:assert/strict'
import test from 'node:test'

// UX-08: the cross-account /banking/imports history page had no way to
// import — no header CTA, no empty-state action. The picker carries the bank
// account context beside the canonical per-account import dialog, and serves
// both slots from one implementation.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/imports',
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
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

Object.assign(globalThis, {
  __importPickerRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__importPickerRouter}',
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
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { ImportAccountPicker } = await import('./ImportAccountPicker')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(props: { accounts: { id: string; label: string }[] }) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ImportAccountPicker accounts={props.accounts} selectLabel="Account" placeholder="Select an account…" />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
  })
  await tick()
  return { host, root }
}

const accounts = [
  { id: 'acc-1', label: '1000 · Operating' },
  { id: 'acc-2', label: '2000 · Savings' },
]

test('the picker offers every reconcilable account beside the import action', async () => {
  const { host, root } = await mount({ accounts })
  try {
    const options = [...host.querySelectorAll('select option')].map((o) => o.textContent?.trim())
    assert.deepEqual(options, ['1000 · Operating', '2000 · Savings'])
    const importButton = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Import statement'),
    )
    assert.ok(importButton, 'the canonical import dialog trigger must render')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

test('the picker renders nothing with no reconcilable account to import into', async () => {
  const { host, root } = await mount({ accounts: [] })
  try {
    assert.equal(host.querySelectorAll('button').length, 0)
    assert.equal(host.querySelectorAll('select').length, 0)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
