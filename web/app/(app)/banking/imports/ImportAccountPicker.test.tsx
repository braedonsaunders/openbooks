import assert from 'node:assert/strict'
import test from 'node:test'

// the cross-account /banking/imports history page had no way to
// import — no header CTA, no empty-state action. The picker carries the bank
// account context beside the canonical per-account import dialog, and serves
// both slots from one implementation.
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/banking/imports', scrollIntoView: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__importPickerRouter}' })

Object.assign(globalThis, {
  __importPickerRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
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
