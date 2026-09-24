import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4800/payroll/profiles',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
