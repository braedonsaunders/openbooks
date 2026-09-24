import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __typeBuilderRouter: { refresh(): void }
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4800/records/types?type=type-1',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: worktreeUi }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__typeBuilderRouter}export function usePathname(){return '/records/types'}export function useSearchParams(){return new URLSearchParams()}",
      }
    }
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',p,p.children)}" }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(){},warning(){}}' }
    }
    if (specifier === '@/lib/confirm' || specifier === '@/lib/prompt') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function confirmDialog(){return true}export async function promptDialog(){return null}' }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return next(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
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
