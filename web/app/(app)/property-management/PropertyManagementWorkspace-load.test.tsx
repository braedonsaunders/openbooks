import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

// The workspace load parsed the body before the status and threw
// new Error(body.error) — an error body without an error field became
// new Error(undefined) with an empty toast. The load now checks the status
// first through readApiErrorMessage. Mounts the real workspace under jsdom
// and drives both failure shapes.
await bootJsdomEnvironment({ url: 'http://localhost:4800/property-management', matchMediaMatches: false })

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
stubModules({
  navigation: {
    source:
      'export function useRouter(){return globalThis.__propertyTestRouter}' +
      'export function usePathname(){return "/property-management"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      'export const toast={success(){},error(m){(globalThis.__propertyErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}',
  },
})
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
                openInvoices: [], taxCodes: [],
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
