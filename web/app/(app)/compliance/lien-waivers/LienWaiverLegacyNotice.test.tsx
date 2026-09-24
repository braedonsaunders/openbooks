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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){}}}export function useSearchParams(){return new URLSearchParams()}" }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/de')).default
const { LienWaiverLegacyNotice } = await import('./LienWaiverLegacyNotice')

test('legacy waiver notice is localized and only appears for unverified legacy records', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messages} timeZone="UTC">
        <LienWaiverLegacyNotice visible={false} />
      </NextIntlClientProvider>,
    )
  })
  assert.equal(host.textContent, '', 'verified records must not show the legacy warning')

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messages} timeZone="UTC">
        <LienWaiverLegacyNotice visible />
      </NextIntlClientProvider>,
    )
  })
  assert.match(host.textContent ?? '', /Ältere Verzichtserklärung/)
  assert.match(host.textContent ?? '', /Der Ausdruck zeigt aktuelle Datensätze/)
  assert.match(host.textContent ?? '', /Prüfen Sie die beigefügte unterzeichnete Kopie/)
  assert.doesNotMatch(host.textContent ?? '', /Legacy waiver|Verify against the attached/)
})
