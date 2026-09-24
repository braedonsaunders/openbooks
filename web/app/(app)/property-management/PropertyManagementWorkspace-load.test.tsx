import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// F2-7: the workspace load parsed the body before the status and threw
// new Error(body.error) — an error body without an error field became
// new Error(undefined) with an empty toast. The load now checks the status
// first through readApiErrorMessage. Mounts the real workspace under jsdom
// and drives both failure shapes.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/property-management',
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
  __propertyTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__propertyTestRouter}export function usePathname(){return "/property-management"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__propertyErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
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
const { PropertyManagementWorkspace } = await import('./PropertyManagementWorkspace')
const { defaultFormLayout } = await import('@openbooks/customization')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(t: TestContext, responder: () => Response): Promise<void> {
  script.errors = []
  ;(globalThis as Record<string, unknown>).__propertyErrorToasts = script.errors
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
            <PropertyManagementWorkspace
              options={{
                subsidiaries: [],
                locations: [],
                tenants: [],
                incomeAccounts: [],
                expenseAccounts: [],
                liabilityAccounts: [],
                bankAccounts: [],
                assets: [],
                openInvoices: [],
              }}
              permissions={{ manage: false, bill: false, account: false, bulk: false, customize: false }}
              customization={{
                layout: defaultFormLayout('property'),
                forms: [],
                currentFormId: null,
                fieldDefs: [],
                listView: { columns: [] } as never,
              }}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    for (let i = 0; i < 6; i++) await tick()
  })
}

test('a non-JSON 502 names the translated fallback with the status', async (t) => {
  await mount(t, () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
  assert.deepEqual(script.errors, ['Could not load properties (status 502)'])
})

test('a refusal without an error field never becomes an empty toast', async (t) => {
  await mount(t, () => Response.json({ ok: false }, { status: 403 }))
  assert.deepEqual(script.errors, ['Could not load properties (status 403)'])
  assert.ok(
    script.errors.every((message) => message.trim() !== '' && message !== 'undefined'),
    'no toast may be empty or the string undefined',
  )
})
