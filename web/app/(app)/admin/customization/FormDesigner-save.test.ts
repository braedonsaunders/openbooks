import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/customization?recordType=vendor_bill&tab=forms',
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
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const { registerHooks } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copies so the test runs the code under test.
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
const worktreeCustomization = pathToFileURL(join(process.cwd(), 'packages', 'customization', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') {
      return { shortCircuit: true, url: worktreeUi }
    }
    if (specifier === '@openbooks/customization') {
      return { shortCircuit: true, url: worktreeCustomization }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return \'/admin/customization\'}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { FormDesigner } = await import('./FormDesigner')
const { defaultFormLayout } = await import('@openbooks/customization')

const FORM_ID = '019f68a5-6a24-78ec-bed6-cc04e06f2078'

type FetchCall = { url: string; method: string; body: string }
const calls: FetchCall[] = []
globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
  return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

/**
 * F-t10-001 — saving an existing form PATCHed the COLLECTION url
 * (/api/customization/form-layouts), which only serves GET+POST, so every
 * edit died with a silent 405. Updates belong on the member route, which
 * implements PATCH.
 */
test('form edits PATCH the member route, never the collection url', async () => {
  document.body.innerHTML = ''
  calls.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: 'en',
        messages,
        timeZone: 'UTC',
        children: React.createElement(FormDesigner, {
          recordType: 'vendor_bill',
          def: {
            id: FORM_ID,
            name: 'Ops Bill Form',
            isDefault: false,
            isActive: true,
            layout: defaultFormLayout('vendor_bill'),
            recordType: 'vendor_bill',
          },
          headerDefs: [],
          lineDefs: [],
          subsidiaryEnabled: false,
        }),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  /* eslint-enable react/no-children-prop */
  try {
    const save = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Save form')
    assert.ok(save, 'the Save form button must render')
    await act(async () => {
      ;(save as HTMLButtonElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(calls.length, 1, 'saving must send exactly one request')
    assert.equal(calls[0]!.method, 'PATCH')
    assert.equal(calls[0]!.url, `/api/customization/form-layouts/${FORM_ID}`)
    assert.equal((JSON.parse(calls[0]!.body) as { name: string }).name, 'Ops Bill Form')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
