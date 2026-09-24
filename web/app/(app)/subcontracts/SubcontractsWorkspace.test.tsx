import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F2-8: the whole workspace was hard-coded English with zero i18n. Mounts
// the real SubcontractsWorkspace under jsdom and asserts the chrome renders
// through the catalog (en) and a failed load toasts the translated
// fallback with the status.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/subcontracts',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
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

const script = {
  errors: [] as string[],
}
Object.assign(globalThis, {
  __subcontractsTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__subcontractsTestRouter}export function usePathname(){return "/subcontracts"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__subcontractsErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
      }
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
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { SubcontractsWorkspace } = await import('./SubcontractsWorkspace')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  ;(globalThis as Record<string, unknown>).__subcontractsErrorToasts = script.errors
  const prior = globalThis.fetch
  globalThis.fetch = (async () => responder()) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rootHandle = createRoot(host)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    host.remove()
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <SubcontractsWorkspace
              projects={[]}
              vendors={[]}
              expenseAccounts={[]}
              parties={[]}
              permissions={{ create: true, approve: false, post: false, pay: false }}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
}

test('the register chrome renders translated with an empty list', async (t) => {
  await mount(t, () => Response.json({ subcontracts: [] }))
  const text = document.body.textContent ?? ''
  assert.ok(text.includes('Subcontract register'), 'the register title must render')
  assert.ok(text.includes('No subcontracts yet'), 'the empty title must render')
  assert.ok(text.includes('New subcontract'), 'the create action must render')
  assert.ok(
    !/register\.|columns\.|tabs\.|toasts\.|statusNames\./.test(text),
    'no untranslated key path may leak into the chrome',
  )
})

test('a failed list load toasts the translated fallback with the status', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  assert.deepEqual(script.errors, ['Could not load subcontracts (status 502)'])
})

test('a refusal without an error field never toasts an empty message', async (t) => {
  await mount(t, () => Response.json({ ok: false }, { status: 403 }))
  assert.deepEqual(script.errors, ['Could not load subcontracts (status 403)'])
})
