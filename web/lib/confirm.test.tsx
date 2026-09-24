import assert from 'node:assert/strict'
import test from 'node:test'

// House render guard: classic JSX transforms and shared tsx caches need React
// on globalThis before the dialog's component module is evaluated.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/confirm' })
const browser = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'KeyboardEvent', 'Event', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = browser[key]
  }
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { ConfirmRoot, confirmDialog } = await import('./confirm.tsx')

test('Enter on Cancel leaves the confirmation pending for its explicit cancel choice', async () => {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const answer = confirmDialog({ message: 'Delete this posted record?', confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger' })
  const providerProps = { locale: 'en', messages, timeZone: 'UTC', children: null }
  try {
    await act(async () => {
      root.render(
        React.createElement(
          NextIntlClientProvider,
          providerProps,
          React.createElement(ConfirmRoot),
        ),
      )
    })
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    const cancel = buttons.find((button) => button.textContent?.trim() === 'Cancel')
    assert.ok(cancel, 'the dialog exposes its explicit Cancel control')
    await act(async () => {
      cancel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      cancel.click()
    })
    assert.equal(await answer, false, 'keyboard activation of Cancel must resolve false')

    let confirmed!: Promise<boolean>
    await act(async () => {
      confirmed = confirmDialog({ message: 'Delete this posted record?', confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger' })
    })
    await act(async () => {
      root.render(
        React.createElement(
          NextIntlClientProvider,
          providerProps,
          React.createElement(ConfirmRoot),
        ),
      )
    })
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.trim() === 'Delete')
    assert.ok(confirm, 'the dialog exposes its explicit Delete control')
    await act(async () => confirm.click())
    assert.equal(await confirmed, true, 'the explicit confirm choice must resolve true')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    dom.window.close()
  }
})
