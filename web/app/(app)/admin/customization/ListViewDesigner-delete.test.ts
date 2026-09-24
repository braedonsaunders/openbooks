import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/customization?recordType=vendor_bill&tab=views',
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
const { ListViewDesigner } = await import('./ListViewDesigner')
const { defaultListView } = await import('@openbooks/customization')

const VIEW_ID = '019f68a5-6a24-78ec-bed6-cc04e06f2079'

type FetchCall = { url: string; method: string }
const calls: FetchCall[] = []
const confirms: string[] = []
let confirmAnswer = false
window.confirm = ((message: string) => {
  confirms.push(String(message))
  return confirmAnswer
}) as typeof window.confirm
;(globals as Record<string, unknown>).confirm = window.confirm
globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET' })
  return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

/**
 * F-t05-011 — deleting a saved list view fired on one click with no
 * confirmation. Like the banking rule drawer, remove() confirms first, and
 * nothing is sent until the operator accepts.
 */
test('deleting a saved view confirms before the DELETE goes out', async () => {
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
        children: React.createElement(ListViewDesigner, {
          recordType: 'vendor_bill',
          def: {
            id: VIEW_ID,
            name: 'Ops payables',
            scope: 'org',
            isDefault: false,
            isActive: true,
            config: defaultListView('vendor_bill'),
            recordType: 'vendor_bill',
          },
          canManageOrg: true,
          userId: '00000000-0000-4000-8000-00000000a002',
          showInListDefs: [],
          filterOptions: {},
          inventoryEnabled: false,
          crmEnabled: false,
          hrmEnabled: false,
        }),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  /* eslint-enable react/no-children-prop */
  try {
    const remove = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Delete view')
    assert.ok(remove, 'the Delete view button must render')
    await act(async () => {
      ;(remove as HTMLButtonElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(confirms.length, 1, 'deleting the view must ask for confirmation')
    assert.deepEqual(calls, [], 'no DELETE request before the operator confirms')

    confirmAnswer = true
    await act(async () => {
      ;(remove as HTMLButtonElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(calls, [{ url: `/api/customization/list-views/${VIEW_ID}`, method: 'DELETE' }])
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

// F-t05-011 history: the delete confirmation names the fallback consequence,
// so it must exist in every shipped locale.
for (const locale of ['en', 'fr', 'es']) {
  test(`view delete confirmation is translated in ${locale}`, () => {
    const catalog = JSON.parse(
      readFileSync(join(here, '..', '..', '..', '..', 'messages', locale, 'customization.json'), 'utf8'),
    ) as { designer?: { list?: Record<string, unknown> } }
    assert.equal(
      typeof catalog.designer?.list?.deleteConfirm,
      'string',
      `${locale} designer.list.deleteConfirm must exist`,
    )
  })
}
