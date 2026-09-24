import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
