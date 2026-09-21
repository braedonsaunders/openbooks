import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'

// Exercise the house Select and real component; only network and toast are doubles.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/assets?tab=tax' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
globals.requestAnimationFrame ??= dom.window.requestAnimationFrame
globals.cancelAnimationFrame ??= dom.window.cancelAnimationFrame
window.matchMedia ??= (() => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
globals.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
globals.IS_REACT_ACT_ENVIRONMENT = true
const toasts: string[] = []
globals.__taxWindowToasts = toasts
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') return {
      shortCircuit: true,
      url: 'data:text/javascript,export const toast={success(){},error(message){globalThis.__taxWindowToasts.push(String(message))}};export function Toaster(){return null}',
    }
    return next(specifier, context)
  },
})
const React = await import('react')
globals.React = React
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { TaxPoolsView } = await import('./TaxPoolsView')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; dom.window.close() })

const ENTITY = 'e1111111-1111-4111-8111-111111111111'
const OTHER_ENTITY = 'e2222222-2222-4222-8222-222222222222'
const FIRST = 'f1111111-1111-4111-8111-111111111111'
const SECOND = 'f2222222-2222-4222-8222-222222222222'
const windows = [
  { id: FIRST, subsidiaryId: ENTITY, regime: 'ca_cca', filingYear: 2024, yearStart: '2024-01-01', yearEnd: '2024-06-30' },
  { id: SECOND, subsidiaryId: ENTITY, regime: 'ca_cca', filingYear: 2024, yearStart: '2024-07-01', yearEnd: '2024-12-31' },
]
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mount(runResponse?: () => Response, loadResponse?: () => Response) {
  const posts: Record<string, unknown>[] = []
  toasts.length = 0
  globalThis.fetch = (async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return runResponse?.() ?? Response.json({ taxYear: 2024, lines: [], totals: { allowance: '0.00', recapture: '0.00', terminalLoss: '0.00' } })
    }
    const url = new URL(String(input), 'http://localhost')
    assert.equal(url.searchParams.get('view'), 'windows')
    return loadResponse?.() ?? Response.json({ windows: url.searchParams.get('subsidiaryId') === ENTITY ? windows : [] })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TaxPoolsView canConfigure canRun regimes={[{ code: 'ca_cca', name: 'Canada CCA' }]}
        subsidiaries={[{ id: ENTITY, name: 'Company One' }, { id: OTHER_ENTITY, name: 'Company Two' }]} />
    </NextIntlClientProvider>)
  })
  await act(async () => { await tick() })
  return { host, posts, cleanup: async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch } }
}

function runButton(host: HTMLElement) {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Run')
  assert.ok(button, 'the run action renders')
  return button
}

async function select(host: HTMLElement, index: number, value: string) {
  const element = host.querySelectorAll('select')[index]
  assert.ok(element, `native Select proxy ${index} renders`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await tick() })
}

test('two same-label short tax years remain distinct choices and only the selected identity is posted', async (t) => {
  const ui = await mount()
  t.after(ui.cleanup)
  assert.equal(runButton(ui.host).disabled, true, 'a filing year is never selected implicitly')
  const choices = [...ui.host.querySelectorAll('select')[2]!.options]
  assert.deepEqual(choices.map((option) => option.value), ['', FIRST, SECOND])
  assert.match(choices[1]!.text, /2024-01-01.*2024-06-30/)
  assert.match(choices[2]!.text, /2024-07-01.*2024-12-31/)
  await select(ui.host, 2, SECOND)
  assert.equal(runButton(ui.host).disabled, false)
  await act(async () => { runButton(ui.host).click(); await tick() })
  assert.deepEqual(ui.posts, [{ regime: 'ca_cca', subsidiaryId: ENTITY, taxYearWindowId: SECOND }])
  await select(ui.host, 0, OTHER_ENTITY)
  assert.equal(runButton(ui.host).disabled, true, 'switching legal entity clears the previously selected window')
  assert.equal(ui.host.querySelectorAll('select')[2]!.value, '')
  assert.match(ui.host.textContent ?? '', /No tax-year windows are registered/)
  assert.ok(ui.host.querySelector('a[href="/admin/setup/tax-depreciation?tab=years"]'))
})

test('a run refusal remains visible and an unreadable response cannot replace it with a JSON parser error', async (t) => {
  let unreadable = false
  const refusal = 'Register the missing tax year before running depreciation.'
  const ui = await mount(() => unreadable
    ? new Response('<html>proxy failure</html>', { status: 502 })
    : Response.json({ error: refusal }, { status: 422 }))
  t.after(ui.cleanup)
  await select(ui.host, 2, FIRST)
  await act(async () => { runButton(ui.host).click(); await tick() })
  assert.equal(ui.host.querySelector('[role="alert"]')?.textContent, refusal)
  assert.deepEqual(toasts, [refusal])
  unreadable = true
  await act(async () => { runButton(ui.host).click(); await tick() })
  const alert = ui.host.querySelector('[role="alert"]')
  assert.ok(alert?.textContent)
  assert.doesNotMatch(alert.textContent, /Unexpected token|JSON|proxy failure/)
  assert.equal(toasts.length, 2)
})

test('an unavailable calendar exposes the server remedy and prevents the run', async (t) => {
  const ui = await mount(undefined, () => Response.json({ error: 'Choose an active legal entity from this organization.' }, { status: 422 }))
  t.after(ui.cleanup)
  assert.match(ui.host.querySelector('[role="alert"]')?.textContent ?? '', /active legal entity/)
  assert.equal(runButton(ui.host).disabled, true)
  assert.equal(ui.posts.length, 0)
})
