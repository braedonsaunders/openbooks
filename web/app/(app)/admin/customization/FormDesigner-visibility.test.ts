import assert from 'node:assert/strict'
import test from 'node:test'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/customization?recordType=project&tab=forms&form=new',
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

/**
 * Locked field controls remain disabled while editable fields still toggle.
 */
test('designer visibility toggles expose pressed state and flip their label', async () => {
  document.body.innerHTML = ''
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
          def: null,
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
    const lockedBadge = [...document.querySelectorAll('div')].find((node) => node.textContent === 'Locked')
    assert.ok(lockedBadge, 'built-in locked fields render their lock marker')
    const lockedRow = lockedBadge?.parentElement?.parentElement
    assert.equal(lockedRow?.querySelector('button[aria-pressed]')?.hasAttribute('disabled'), true)
    assert.equal(lockedRow?.querySelector('input:not([type="checkbox"])')?.hasAttribute('disabled'), true)
    const toggles = [...document.querySelectorAll('button[aria-pressed="true"]')]
      .filter((b) => !b.hasAttribute('disabled'))
      .reverse()
    assert.ok(toggles.length >= 4, `tab, subtab, action and field toggles must render (found ${toggles.length})`)
    for (const toggle of toggles) {
      assert.equal(toggle.getAttribute('aria-label'), 'Visible')
      await act(async () => {
        toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'the clicked toggle must report unpressed')
      assert.equal(toggle.getAttribute('aria-label'), 'Hidden', 'the clicked toggle must offer its Hidden label')
    }
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
