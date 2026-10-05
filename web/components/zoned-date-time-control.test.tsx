import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/hrm/training', event: 'jsdom' })
stubModules({ navigation: false, intl: false, authz: false, features: false })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React,
  { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { ZonedDateTimeControl } = await import('./zoned-date-time-control')

async function edit(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('local-time control keeps gaps unsaved and repeated hours require an explicit occurrence', async (t) => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const writes: string[] = []
  function Fixture() {
    const [value, setValue] = React.useState('')
    return (
      <ZonedDateTimeControl
        value={value}
        zone="America/Toronto"
        label="Start"
        onChange={(next) => {
          writes.push(next)
          setValue(next)
        }}
      />
    )
  }
  t.after(async () => {
    await act(() => root.unmount())
    host.remove()
  })
  await act(() =>
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <Fixture />
      </NextIntlClientProvider>,
    ),
  )
  const date = host.querySelector('input[type=date]') as HTMLInputElement
  const time = host.querySelector('input[type=time]') as HTMLInputElement
  await edit(date, '2026-03-08')
  await edit(time, '02:30')
  assert.equal(writes.at(-1), '')
  assert.match(host.querySelector('[role=alert]')?.textContent ?? '', /does not exist.*choose another time/i)
  await edit(date, '2026-11-01')
  await edit(time, '01:30')
  assert.equal(writes.at(-1), '', 'The earlier occurrence must never be guessed')
  const occurrence = host.querySelector('select') as HTMLSelectElement
  assert.ok(occurrence)
  assert.deepEqual(
    [...occurrence.options].slice(1).map((option) => option.value),
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
  )
  await act(() => {
    occurrence.value = '2026-11-01T06:30:00.000Z'
    occurrence.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.equal(writes.at(-1), '2026-11-01T06:30:00.000Z')
  assert.equal(time.value, '01:30')
  assert.equal(host.querySelector('select'), occurrence, 'Resolution keeps the existing control mounted')
})
