import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-07: Documents Upload with no folder selected must show a visible,
// accessible reason (not an unreachable toast) and a folder-selection
// action. With a folder, the button stays bare and enabled.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/documents',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

Object.assign(globalThis, {
  __uploadTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__uploadTestRouter}export function usePathname(){return "/documents"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const { UploadButton } = await import('./UploadButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountUpload(t: TestContext, folderId?: string): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <UploadButton folderId={folderId} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

test('no folder shows a visible reason and a folder-selection action', async (t) => {
  await mountUpload(t, undefined)
  const button = document.querySelector('button')
  assert.ok(button, 'the Upload button must render')
  assert.equal(button.disabled, true, 'upload without a destination stays disabled')
  const describedBy = button.getAttribute('aria-describedby')
  assert.equal(describedBy, 'documents-upload-hint', 'the disabled button must describe its reason')
  const hint = document.getElementById('documents-upload-hint')
  assert.ok(hint, 'the reason must be a visible element, not a toast')
  assert.match(hint.textContent ?? '', /pick a folder/, 'the reason must name the missing folder')
  const action = hint.querySelector('a[href="#documents-folder-tree"]')
  assert.ok(action, 'the reason must carry a folder-selection action')
  assert.match(action.textContent ?? '', /Select folder/, 'the action must name its remedy')
})

test('the folder action focuses the folder tree', async (t) => {
  await mountUpload(t, undefined)
  const tree = document.createElement('div')
  tree.id = 'documents-folder-tree'
  tree.tabIndex = -1
  document.body.appendChild(tree)
  let focused = false
  tree.focus = (() => {
    focused = true
  }) as typeof tree.focus
  const action = document.querySelector('a[href="#documents-folder-tree"]') as HTMLAnchorElement | null
  assert.ok(action, 'the folder-selection action must exist')
  await act(async () => {
    action.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await tick()
  })
  assert.equal(focused, true, 'the action must move focus to the folder tree')
})

test('a selected folder keeps the button bare and enabled', async (t) => {
  await mountUpload(t, 'folder-1')
  const button = document.querySelector('button')
  assert.ok(button, 'the Upload button must render')
  assert.equal(button.disabled, false, 'upload with a folder stays enabled')
  assert.equal(button.getAttribute('aria-describedby'), null, 'no reason is needed when upload works')
  assert.equal(document.getElementById('documents-upload-hint'), null, 'no hint when a folder is selected')
})
