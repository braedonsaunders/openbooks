import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __typeBuilderRouter: { refresh(): void }
}

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/records/types?type=type-1', matchMediaMatches: false })

const { registerHooks } = await import('node:module')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
// The @openbooks/ui redirect is a worktree pin, not a stub shape: it stays
// in a local hook while the remaining stubs move to the shared helper.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: worktreeUi }
    return next(specifier, context)
  },
})

const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__typeBuilderRouter}export function usePathname(){return '/records/types'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link':
      "export default function Link(p){return globalThis.React.createElement('a',p,p.children)}",
    sonner: 'export const toast={success(){},error(){},warning(){}}',
    '@/lib/confirm': 'export async function confirmDialog(){return true}',
    '@/lib/prompt': 'export async function promptDialog(){return null}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { TypeBuilderDrawer } = await import('./TypeBuilderDrawer')

const type = {
  id: 'type-1',
  key: 'purchase_order',
  name: 'Purchase Order',
  pluralName: 'Purchase Orders',
  iconKey: 'file-text',
  description: null,
  fields: [{ id: 'details', title: 'Details', fields: [{ id: 'name', type: 'text', label: 'Name' }] }],
  status: 'published' as const,
  showInNav: true,
  allowedRoles: null,
  sortOrder: 1,
  updated_at: '2026-09-17T12:00:00.000000Z',
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'the browser input value setter is available')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
}

test('each record-type autosave uses the newest revision returned by the previous save', async (t) => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method?: string; body?: unknown }> = []
  let responseRevision = '2026-09-17T12:00:01.000000Z'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
    const revision = responseRevision
    responseRevision = '2026-09-17T12:00:02.000000Z'
    return Response.json({ type: { updated_at: revision }, issues: [] })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  globalThis.__typeBuilderRouter = { refresh() {} }
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
        <TypeBuilderDrawer type={type} roles={[]} />
      </NextIntlClientProvider>,
    )
    await tick()
  })

  // UrlDrawer portals its panel to document.body, outside the render host.
  const nameInput = [...document.querySelectorAll('input')].find((input) => input.value === 'Purchase Order')
  assert.ok(nameInput, 'the loaded type name is editable')

  await act(async () => {
    changeInput(nameInput!, 'Purchase Order East')
    await tick(700)
  })
  await act(async () => tick())

  assert.equal(requests.length, 1, 'the first edit autosaves once')
  assert.equal(requests[0]?.url, '/api/records/types/type-1')
  assert.equal(requests[0]?.method, 'PATCH')
  assert.deepEqual(requests[0]?.body, {
    name: 'Purchase Order East',
    pluralName: 'Purchase Order Easts',
    iconKey: 'file-text',
    description: null,
    showInNav: true,
    sortOrder: 1,
    allowedRoles: null,
    fields: type.fields,
    expectedUpdatedAt: type.updated_at,
  })

  await act(async () => {
    changeInput(nameInput!, 'Purchase Order West')
    await tick(700)
  })
  await act(async () => tick())

  assert.equal(requests.length, 2, 'the next edit also autosaves once')
  assert.equal((requests[1]?.body as { expectedUpdatedAt: string }).expectedUpdatedAt, '2026-09-17T12:00:01.000000Z')
  assert.equal((requests[1]?.body as { name: string }).name, 'Purchase Order West')
})
