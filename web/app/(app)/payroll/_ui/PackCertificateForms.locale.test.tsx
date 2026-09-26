import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'http://localhost:4800/payroll/profiles', matchMediaMatches: false })

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/fr')).default
const { PackCertificateForms } = await import('./PackCertificateForms')

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

test('pack certificate loading and section headings use the viewer locale', async (t) => {
  let finishLoad!: (response: Response) => void
  const previousFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    finishLoad = resolve
  })) as typeof fetch
  t.after(() => {
    globalThis.fetch = previousFetch
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const child of [...document.body.children]) child.remove()
  })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <PackCertificateForms partyId="employee-1" country="NL" />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  assert.match(host.textContent ?? '', /Chargement des certificats/)

  await act(async () => {
    finishLoad(new Response(JSON.stringify({
      declarations: {
        NL: {
          certificates: [{
            key: 'sample',
            form: 'Sample form',
            label: 'Sample certificate',
            scope: { level: 'country' },
            citation: 'Published filing instructions',
            summary: 'Filing summary',
            fields: [],
          }],
        },
      },
      stored: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await tick()
  })

  assert.match(host.textContent ?? '', /Certificats fiscaux/)
  assert.doesNotMatch(host.textContent ?? '', /Loading certificates|Tax certificates/)
})
