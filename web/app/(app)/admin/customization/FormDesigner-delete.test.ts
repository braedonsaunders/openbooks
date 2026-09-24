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

type FetchCall = { url: string; method: string }
const calls: FetchCall[] = []
const confirms: string[] = []
let confirmAnswer = false
window.confirm = ((message: string) => {
  confirms.push(String(message))
  return confirmAnswer
}) as typeof window.confirm
globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET' })
  return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function mountDefault() {
  document.body.innerHTML = ''
  calls.length = 0
  confirms.length = 0
  confirmAnswer = false
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
            name: 'Standard Bill Form',
            isDefault: true,
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
  return {
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function deleteButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Delete form')
  assert.ok(found, 'the Delete form button must render')
  return found as HTMLButtonElement
}

/**
 * F-t10-004 — deleting the org-default form fired on one click with no
 * confirmation and left the record type with no default (falling back to
 * the standard layout silently). Deleting the default confirms first, and
 * nothing is sent until the operator accepts.
 */
test('deleting the org-default form confirms before the DELETE goes out', async () => {
  const { unmount } = await mountDefault()
  try {
    await act(async () => {
      deleteButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(confirms.length, 1, 'deleting the default must ask for confirmation')
    assert.match(confirms[0]!, /Standard Bill Form/, 'the confirmation must name the form being deleted')
    assert.deepEqual(calls, [], 'no DELETE request before the operator confirms')

    confirmAnswer = true
    await act(async () => {
      deleteButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(calls, [{ url: `/api/customization/form-layouts/${FORM_ID}`, method: 'DELETE' }])
  } finally {
    await unmount()
  }
})
