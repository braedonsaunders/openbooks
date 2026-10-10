// The shared missing-grant hint names the permission a hidden or
// disabled action needs, so the operator knows what to ask their
// administrator for instead of staring at a missing button.
import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/estimates', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { PermissionHint } = await import('./permission-hint')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('the hint names the permission and the action', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PermissionHint permission="estimates.create" action="estimates" />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  const text = host.textContent ?? ''
  assert.match(text, /estimates\.create/, 'the grant is named exactly')
  assert.match(text, /estimates/, 'the action is named')
  assert.match(text, /administrator/i, 'the remedy points at the administrator')
})
