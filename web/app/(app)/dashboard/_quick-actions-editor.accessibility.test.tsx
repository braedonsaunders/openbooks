import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/dashboard', matchMediaMatches: false, scrollIntoView: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {refresh(){},push(){}}}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={error(){},success(){}}' }
    }
    if (specifier === './actions' && context.parentURL?.includes('_quick-actions-editor.tsx')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function listQuickActionOptions(){return {common:[],custom:[]}};export async function saveQuickActions(){return {ok:true}}' }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { QuickActionsEditor } = await import('./_quick-actions-editor')

test('quick action reorder and remove buttons use translated names', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QuickActionsEditor
          open
          value={[{ id: 'invoices', label: 'Invoices', href: '/ar/invoices', iconKey: 'file', tone: 'sky' }]}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.ok(document.querySelector('button[aria-label="Previous"]'), 'move up uses the translated previous name')
  assert.ok(document.querySelector('button[aria-label="Next"]'), 'move down uses the translated next name')
  assert.ok(document.querySelector('button[aria-label="Remove"]'), 'remove uses the translated remove name')
})

test('quick action icon and color choices expose human-readable names', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QuickActionsEditor
          open
          value={[{ id: 'invoices', label: 'Invoices', href: '/ar/invoices', iconKey: 'file', tone: 'sky' }]}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const edit = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Invoices'))
  assert.ok(edit, 'quick action can be edited')
  await act(async () => edit.click())
  assert.ok(document.querySelector('button[aria-label="Icon: Shield Alert"]'), 'icon name describes the selected glyph')
  assert.ok(document.querySelector('button[aria-label="Color: Rose"]'), 'color name describes the selected swatch')
  assert.equal(document.querySelector('button[aria-label="shield-alert"]'), null, 'raw icon ids are not exposed')
})
