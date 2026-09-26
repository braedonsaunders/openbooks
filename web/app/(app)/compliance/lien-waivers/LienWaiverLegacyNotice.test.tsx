import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'about:blank', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {push(){},refresh(){}}}export function useSearchParams(){return new URLSearchParams()}' })

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
