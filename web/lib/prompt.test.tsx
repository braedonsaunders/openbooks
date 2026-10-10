import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// The void dialog's reason field gates its confirm button on the controlled
// value — but a programmatic fill (autofill, a script setting the field)
// lands in the element without React's onChange firing. The dialog must
// still enable Void and submit the visible text: enablement re-syncs from
// the live element on focus/blur, and submit reads the field itself. These
// tests drive the real PromptRoot the way the void flow opens it.
await bootJsdomEnvironment({ html: "<!doctype html><html><body></body></html>", url: "http://localhost:4800/prompt" });

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { PromptRoot, promptDialog } = await import('./prompt.tsx')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountRoot(): Promise<() => Promise<void>> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: 'en', messages, timeZone: 'UTC' },
        React.createElement(PromptRoot),
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

function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#prompt-input')
  assert.ok(input, 'the prompt exposes its reason field')
  return input
}

function confirmButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')
  assert.ok(button, 'the dialog exposes its confirm button')
  return button
}

/** Fill the field the way a script does: straight into the element, no events. */
function programmaticFill(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, text)
}

test('typing a reason enables the confirm button', async () => {
  const unmount = await mountRoot()
  try {
    const pending = promptDialog({ title: 'Void', confirmLabel: 'Void' })
    await act(async () => {
      await tick()
    })
    assert.equal(confirmButton().disabled, true, 'empty reason keeps Void disabled')
    await act(async () => {
      const input = field()
      input.focus()
      // A real keystroke travels through React's onChange: the element's
      // value changes and the input event carries it into state.
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      nativeSetter.call(input, 'duplicate charge')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    assert.equal(confirmButton().disabled, false, 'typed text enables Void')
    await act(async () => {
      confirmButton().click()
      await tick()
    })
    assert.equal(await pending, 'duplicate charge')
  } finally {
    await unmount()
  }
})

test('a programmatic fill enables Void on focus and submits its text', async () => {
  const unmount = await mountRoot()
  try {
    const pending = promptDialog({ title: 'Void', confirmLabel: 'Void' })
    await act(async () => {
      await tick()
    })
    const input = field()
    assert.equal(confirmButton().disabled, true, 'empty reason keeps Void disabled')
    programmaticFill(input, 'entered by autofill')
    assert.equal(input.value, 'entered by autofill', 'the fill is visible in the field')
    await act(async () => {
      // Blur first: the mount effect may have left the field focused, and
      // focusing an already-focused field dispatches nothing.
      input.blur()
      await tick()
      input.focus()
      await tick()
    })
    assert.equal(confirmButton().disabled, false, 'the fill enables Void once the field is interacted with')
    await act(async () => {
      confirmButton().click()
      await tick()
    })
    assert.equal(await pending, 'entered by autofill')
  } finally {
    await unmount()
  }
})

test('submitting a programmatically filled field resolves its text, never a silent cancel', async () => {
  const unmount = await mountRoot()
  try {
    const pending = promptDialog({ title: 'Void', confirmLabel: 'Void' })
    await act(async () => {
      await tick()
    })
    const input = field()
    programmaticFill(input, 'keyboard-submitted fill')
    await act(async () => {
      const form = input.closest('form')
      assert.ok(form, 'the prompt renders a form')
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await tick()
    })
    assert.equal(await pending, 'keyboard-submitted fill')
  } finally {
    await unmount()
  }
})
