import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ matchMediaMatches: false })
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { SchemaBrowser } = await import('./SchemaBrowser')

test('schema browser marks only columns declared as primary or unique keys', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const tables = [{
    name: 'sample_view',
    kind: 'view' as const,
    columns: [
      { name: 'required_text', type: 'text', nullable: false, isKey: false },
      { name: 'nullable_unique', type: 'text', nullable: true, isKey: true },
    ],
  }]
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SchemaBrowser tables={tables} loading={false} error={null} onInsert={() => {}} onBrowse={() => {}} />
      </NextIntlClientProvider>,
    )
  })
  await act(async () => {
    host.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(host.querySelector('[data-column-key="required_text"]'), null)
  assert.ok(host.querySelector('[data-column-key="nullable_unique"]'))
})
