import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ComponentType, ReactNode } from 'react'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

await bootJsdomEnvironment({ url: 'http://localhost/ar/invoices', event: 'jsdom' })
Object.defineProperty(globalThis.navigator, 'languages', { value: ['en-US'], configurable: true })

stubModules({
  intl: false,
  extra: { sonner: 'export const toast={success(){},error(m){(globalThis.__dateEntryToasts??=[]).push(m)}};export function Toaster(){return null}' },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{ locale: string; messages: typeof messages; timeZone: string; children?: ReactNode }>
const { BusinessDateProvider } = await import('./business-date-provider')
const { DateEntryKeyboard } = await import('./date-entry-keyboard')
const { Input } = await import('@openbooks/ui')

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const toasts = () => ((globalThis as Record<string, unknown>).__dateEntryToasts ??= []) as string[]

/** A controlled date field, as document forms render it, recording what the owner received. */
function Field({ initial = '', received, ...rest }: { initial?: string; received: string[]; min?: string; max?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <Input
      type="date"
      aria-label="Invoice date"
      value={value}
      onChange={(event) => {
        received.push(event.target.value)
        setValue(event.target.value)
      }}
      {...rest}
    />
  )
}

async function mount(t: TestContext, field: ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-10-17">
          <DateEntryKeyboard />
          {field}
        </BusinessDateProvider>
      </IntlProvider>,
    )
    await tick()
  })
  const input = host.querySelector('input[type="date"]') as HTMLInputElement
  input.focus()
  return input
}

async function key(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    input.dispatchEvent(event)
    await tick()
  })
  return event
}

async function paste(input: HTMLInputElement, text: string) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } })
  await act(async () => {
    input.dispatchEvent(event)
    await tick()
  })
  return event
}

async function typeValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    await tick()
  })
}

test('date keys reach the owner through onChange from the business date', async (t) => {
  const received: string[] = []
  const input = await mount(t, <Field received={received} />)
  const event = await key(input, 't')
  assert.equal(event.defaultPrevented, true)
  await key(input, '+')
  await key(input, '+')
  await key(input, '-')
  await key(input, 'M')
  await key(input, 'm')
  await key(input, 'H')
  await key(input, 'R')
  await key(input, 'Y')
  assert.deepEqual(received, ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-18', '2026-10-01', '2026-09-01', '2026-09-30', '2026-12-31', '2026-01-01'])
  assert.equal(input.value, '2026-01-01')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /2026/, 'the change is announced to assistive technology')
})

test('modified keys, other keys and disabled fields are left to the browser', async (t) => {
  const received: string[] = []
  const input = await mount(t, <Field received={received} initial="2026-03-15" />)
  const withCtrl = await key(input, 't', { ctrlKey: true })
  const digit = await key(input, '4')
  assert.equal(withCtrl.defaultPrevented, false)
  assert.equal(digit.defaultPrevented, false)
  assert.deepEqual(received, [])

  const disabledReceived: string[] = []
  const disabled = await mount(t, <Field received={disabledReceived} initial="2026-03-15" disabled />)
  const ignored = await key(disabled, 't')
  assert.equal(ignored.defaultPrevented, false)
  assert.deepEqual(disabledReceived, [])
})

test('a key that would leave the field range refuses and keeps the value', async (t) => {
  const received: string[] = []
  const input = await mount(t, <Field received={received} initial="2026-10-17" max="2026-10-17" min="2026-10-01" />)
  await key(input, '+')
  await key(input, 'M')
  await key(input, 'M')
  assert.deepEqual(received, ['2026-10-01'], 'only the in-range move landed')
  assert.equal(input.value, '2026-10-01')
})

test('pasted dates read forgivingly; unreadable or impossible text keeps the value and says why', async (t) => {
  const received: string[] = []
  const input = await mount(t, <Field received={received} initial="2026-01-01" />)
  await paste(input, ' 3/15/26 ')
  await paste(input, 'March 20th')
  await paste(input, '2026-04-01')
  assert.deepEqual(received, ['2026-03-15', '2026-03-20', '2026-04-01'])
  toasts().length = 0
  const refused = await paste(input, 'next tuesday')
  await paste(input, '2/30/2026')
  assert.equal(refused.defaultPrevented, true, 'the browser never receives the unreadable text')
  assert.deepEqual(received, ['2026-03-15', '2026-03-20', '2026-04-01'], 'no refused paste reaches the owner')
  assert.equal(input.value, '2026-04-01')
  assert.equal(toasts().length, 2)
  assert.match(toasts()[0]!, /next tuesday/)
})

test('a short typed year settles to the nearest century on blur; stored dates are never rewritten', async (t) => {
  const received: string[] = []
  const input = await mount(t, <Field received={received} initial="0099-12-25" />)
  input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
  await blur(input)
  assert.equal(input.value, '0099-12-25', 'tabbing through a stored date leaves it alone')

  input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
  await typeValue(input, '0026-03-15')
  await blur(input)
  assert.equal(input.value, '2026-03-15')
  assert.equal(received.at(-1), '2026-03-15', 'the owner receives the settled year')

  input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
  await typeValue(input, '0202-03-15')
  await key(input, 'Enter')
  assert.equal(input.value, '0202-03-15', 'a three-digit year is not guessed at')
  assert.equal(input.getAttribute('aria-invalid'), 'true', 'it is marked for correction instead')
  await typeValue(input, '2027-03-15')
  assert.equal(input.hasAttribute('aria-invalid'), false, 'a complete entry clears the mark')
})
