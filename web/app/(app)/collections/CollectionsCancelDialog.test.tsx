import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env.ts'

// The cancel-subscription confirmation must offer two unmistakable choices —
// "Keep subscription" to back out, "Cancel subscription" to confirm — never
// two identical "Cancel" buttons. These tests drive the real ConfirmRoot
// with the catalog strings the cancel flow passes.
await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "http://localhost:4800/collections" });

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default as {
  ar: { collections: { subscriptions: Record<string, string> } }
  common: { confirm: Record<string, string> }
}
const { ConfirmRoot, confirmDialog } = await import('../../../lib/confirm.tsx')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const strings = messages.ar.collections.subscriptions
assert.ok(strings.keepSubscription && strings.cancelSubscription, 'the cancel flow copy must exist')

async function mountRoot(): Promise<() => Promise<void>> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' },
        React.createElement(ConfirmRoot),
      ),
    )
  })
  return async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  }
}

function dialogButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
}

test('canceling a subscription offers Keep and Cancel-subscription, never two Cancels', async () => {
  const unmount = await mountRoot()
  try {
    const pending = confirmDialog({
      title: 'Cancel subscription?',
      message: 'Canceling ends recurring billing for this subscription. This cannot be undone.',
      confirmLabel: strings.cancelSubscription,
      cancelLabel: strings.keepSubscription,
      tone: 'danger',
    })
    await act(async () => {
      await tick()
    })
    const labels = dialogButtons().map((button) => (button.textContent ?? '').trim())
    assert.ok(labels.includes(strings.keepSubscription), 'keeping the subscription is explicit')
    assert.ok(labels.includes(strings.cancelSubscription), 'confirming the cancel is explicit')
    assert.equal(
      labels.filter((label) => label === messages.common.confirm.cancel).length,
      0,
      'no bare Cancel remains once both choices are named',
    )
    await act(async () => {
      dialogButtons().find((button) => (button.textContent ?? '').trim() === strings.cancelSubscription)!.click()
      await tick()
    })
    assert.equal(await pending, true)
  } finally {
    await unmount()
  }
})

test('keeping the subscription resolves false', async () => {
  const unmount = await mountRoot()
  try {
    const pending = confirmDialog({
      title: 'Cancel subscription?',
      message: 'Canceling ends recurring billing for this subscription. This cannot be undone.',
      confirmLabel: strings.cancelSubscription,
      cancelLabel: strings.keepSubscription,
      tone: 'danger',
    })
    await act(async () => {
      await tick()
    })
    await act(async () => {
      dialogButtons().find((button) => (button.textContent ?? '').trim() === strings.keepSubscription)!.click()
      await tick()
    })
    assert.equal(await pending, false)
  } finally {
    await unmount()
  }
})
